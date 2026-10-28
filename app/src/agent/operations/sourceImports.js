/** Source discovery and jobs shared by Agent inspection and approved imports. */
import { BACKEND_API_BASE } from '../../backendConfig.js';
import { SNAPSHOT_ROW_LIMIT } from '../../datasetDownloads.js';

export const FILTER_OPERATORS = ['equals', 'not_equals', 'contains', 'in', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'];

export function sourceOptions(source, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object.');
  const allowed = new Set(['filters', ...(source.option_fields || []).filter((field) => field.type !== 'password').map((field) => field.key), ...(source.kind === 'snapshot' ? ['dataset', 'limit'] : [])]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unsupported option ${key}. Configure credentials outside the Agent conversation.`);
  if (source.kind === 'snapshot') {
    if (!source.datasets?.some((file) => file.name === options.dataset)) throw new Error('Choose an exact dataset filename from inspect_source.');
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > SNAPSHOT_ROW_LIMIT)) throw new Error(`limit must be between 1 and ${SNAPSHOT_ROW_LIMIT}.`);
  }
  const filters = options.filters ?? [];
  if (!Array.isArray(filters) || filters.length > 10) throw new Error('Use at most 10 filters, combined with AND.');
  if (filters.length && source.row_filters === false) throw new Error('This source uses its native search query for filtering. Use search_source with the source query syntax, then import the selected IDs.');
  for (const rule of filters) {
    if (!rule || !Object.hasOwn(source.fields, rule.column)) throw new Error('Filter columns must be chosen from inspect_source fields.');
    const op = rule.op || 'equals';
    if (!FILTER_OPERATORS.includes(op)) throw new Error(`Unsupported filter operator: ${op}`);
    if (rule.case_sensitive !== undefined && typeof rule.case_sensitive !== 'boolean') throw new Error('case_sensitive must be a boolean.');
    if (op === 'in') {
      if (!Array.isArray(rule.values) || !rule.values.length || rule.values.length > 100) throw new Error('in requires 1 to 100 values.');
    } else if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
      if (!['number', 'string'].includes(typeof rule.value) || String(rule.value).trim() === '' || !Number.isFinite(Number(rule.value))) throw new Error('Numeric filters require a finite numeric value.');
    } else if (!['is_empty', 'not_empty'].includes(op) && (!Object.hasOwn(rule, 'value') || (rule.value !== null && typeof rule.value === 'object'))) throw new Error('This filter requires a single value.');
  }
  return { ...options, ...(source.kind === 'snapshot' ? { limit: options.limit ?? SNAPSHOT_ROW_LIMIT } : {}) };
}

export function importDescription(note, source, options, fetched) {
  const lines = [String(note ?? `Imported from ${source.label}.`)];
  if (source.kind === 'snapshot') lines.push(`Source file: ${options.dataset}.`);
  if (options.filters?.length) lines.push(`Import filters (AND): ${options.filters.map((rule) => `${rule.column} ${rule.op || 'equals'}${['is_empty', 'not_empty'].includes(rule.op) ? '' : ` ${JSON.stringify(rule.op === 'in' ? rule.values : rule.value)}`}${rule.case_sensitive ? ' (case-sensitive)' : ''}`).join('; ')}.`);
  if (fetched?.truncated) lines.push(`Import note: Only the first ${fetched.rows.length.toLocaleString('en-US')} matching rows were imported. Remaining matching rows were not imported.`);
  return lines.filter(Boolean).join('\n\n');
}

async function json(path, options = {}) {
  const response = await fetch(`${BACKEND_API_BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Source request failed (HTTP ${response.status}).`);
  return data;
}

async function pause(signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('Cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 350);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Cancel late-starting jobs too, including an AbortSignal fired during the POST. */
export async function sourceJob(source, path, body, { signal, onStatus, download = false } = {}) {
  signal?.throwIfAborted();
  let jobId;
  let finished = false;
  try {
    // Keep the POST alive so an abort cannot lose its newly allocated job ID.
    const started = await json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    jobId = started.job_id;
    if (!jobId) throw new Error('The source did not return a job ID.');
    const deadline = Date.now() + (download ? 2 * 60 * 60 * 1000 : source === 'blast' ? 15 * 60 * 1000 : 5 * 60 * 1000);
    for (;;) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error('The source job timed out.');
      const data = await json(`/api/${source}/import/result/${encodeURIComponent(jobId)}`, { signal });
      if (data.status !== 'running') {
        finished = true;
        if (data.error) throw new Error(String(data.error));
        if (data.status === 'cancelled') throw new Error('The source job was cancelled.');
        return data;
      }
      onStatus?.(data.phase === 'downloading' && data.download_total_bytes
        ? `Downloading ${source}: ${Math.round((data.downloaded_bytes || 0) / data.download_total_bytes * 100)}%`
        : `${source}: ${data.phase === 'preparing' ? 'preparing columns' : 'importing records'}...`);
      await pause(signal);
    }
  } finally {
    if (jobId && !finished) void fetch(`${BACKEND_API_BASE}/api/${source}/import/cancel/${encodeURIComponent(jobId)}`, { method: 'POST' }).catch(() => {});
  }
}

export async function snapshotSchema(source, dataset, { signal } = {}) {
  const status = await json(`/api/reference/import/downloads?source=${encodeURIComponent(source)}`, { signal });
  const file = status.files.find((item) => item.name === dataset);
  if (!file) throw new Error('Choose a dataset file from inspect_source.');
  if (file.status !== 'downloaded') return { needs_download: true, dataset, bytes: file.bytes, status: file.status };
  const result = await sourceJob(source, `/api/reference/import/sources/${source}/schema`, { dataset }, { signal });
  return { ...result.schema, needs_download: false };
}

export async function sourcesForImports(sources, operations, { signal } = {}) {
  const result = { ...sources };
  for (const op of operations || []) {
    if (op.op !== 'import_dataset' || sources[op.source]?.kind !== 'snapshot') continue;
    const dataset = op.options?.dataset;
    if (!sources[op.source].datasets.some((file) => file.name === dataset)) throw new Error('Choose an exact dataset filename from inspect_source.');
    const schema = await snapshotSchema(op.source, dataset, { signal });
    if (schema.needs_download) throw new Error('This file is not downloaded. Propose download_dataset first, then inspect_source before importing.');
    // Different files of one group may have different schemas; indexed separately for planning.
    result[`${op.source}:${dataset}`] = { ...sources[op.source], ...schema };
  }
  return result;
}

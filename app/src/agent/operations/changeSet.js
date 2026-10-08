/**
 * The Agent's change proposals, applied to a getCanvasState() snapshot. Pure: planChangeSet takes a
 * canvas state and a list of operations and returns the next state (for loadCanvasState) plus a
 * readable description of every change for the confirmation card. Any invalid operation throws a
 * ChangeSetError and nothing is applied, so a proposal lands on the canvas whole or not at all.
 *
 * Nodes are referenced by their canvas id, or, for nodes added earlier in the same proposal, by the
 * "$name" ref given when adding them.
 */
import { normalizeDatasetContent } from '../../datasetContent.js';
import { datasetHistorySource } from '../../datasetHistorySource.js';
import { referencedDatasetAliasNames } from '../../processDatasetBindings.js';
import { rebuildWorkingFromApplied } from '../../reviewWorkingSections.js';
import { buildRunResultsTable } from '../../runResultsExport.js';
import {
  RESULT_PORT, processInputBindings, processPrimarySource, runInputSource, setProcessInputs, setProcessPrimarySource, setRunInputSource,
} from '../../stepInputs.js';
import { parseScoreMappingBundle, serializeScoreMappingBundle } from '../../scoreMappingBundle.js';
import { nodeTitle, processOutputsOf, runInputContentOf, runResultsOf } from '../canvas/workflowNodeInspector.js';

export class ChangeSetError extends Error {
  constructor(message, index = null) {
    super(index == null ? message : `Operation ${index + 1}: ${message}`);
    this.name = 'ChangeSetError';
    this.operationIndex = index;
  }
}

const NODE_WIDTH = 320;
const NODE_HEIGHT = 170;
const INPUT_TYPES = ['text', 'image', 'pdf'];
const OUTPUT_TYPES = ['str', 'float', 'list_str', 'list_float'];
const RETURN_SHAPES = ['single', 'table'];

const MATCH_FLAG_KEYS = {
  contains: 'contains',
  ignore_case: 'ignoreCase',
  ignore_symbols: 'ignoreSymbols',
  ignore_whitespace: 'ignoreWhitespace',
  semantic: 'semanticAlign',
  embedding: 'embeddingSimilarity',
  rxnorm: 'rxnormMatch',
  mesh: 'meshMatch',
};

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function fail(message) {
  throw new ChangeSetError(message);
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function generateNodeId() {
  return `n_${Date.now()}_${(Math.random() * 1e9) | 0}`;
}

function uniqueName(requested, taken) {
  const base = clean(requested);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function datasetColumns(node) {
  const content = normalizeDatasetContent(node?.datasetContent || { headers: [], rows: [] });
  return content.headers.map((name, i) => ({ name, type: content.columnTypes[i] || 'text' }));
}

function promptInputs(node, extractInputFields) {
  const types = node?.inputTypes && typeof node.inputTypes === 'object' ? node.inputTypes : {};
  return extractInputFields(node?.sections || []).map((name) => ({ name, type: types[name] || 'text' }));
}

function sectionsText(sections) {
  return (sections || []).map((s) => `## ${s.name}\n${s.content}`).join('\n\n');
}

function outputText(output) {
  const fields = (output?.fields || []).map((f) => `- ${f.key} (${f.type})${f.description ? `: ${f.description}` : ''}`);
  return [`Return shape: ${output?.returnShape || 'single'}`, ...fields].join('\n');
}

/**
 * @param {object} state getCanvasState() output
 * @param {object[]} operations
 * @param {{extractInputFields: Function, sources?: object, imported?: Map<number, {headers: string[], rows: string[][]}>,
 *   now?: () => string}} ctx imported holds rows fetched for import
 *   operations (by operation index); without it an import becomes an empty placeholder table.
 * @returns {{state: object, items: object[], refs: Record<string, string>, warnings: string[], nodeIds: string[]}}
 */
export function planChangeSet(state, operations, ctx) {
  if (!Array.isArray(operations) || operations.length === 0) fail('A proposal needs at least one operation.');
  if (typeof ctx?.extractInputFields !== 'function') fail('extractInputFields is required.');
  const next = {
    ...state,
    nodes: (state?.nodes || []).map((n) => ({ ...n })),
    connections: (state?.connections || []).map((c) => ({ ...c })),
  };
  const refs = {};
  const items = [];
  const warnings = [];
  const touched = new Set();

  const byId = () => new Map(next.nodes.map((n) => [n.nodeId, n]));

  function resolve(value, label, types = null) {
    const raw = clean(value);
    if (!raw) fail(`${label} is required.`);
    const id = raw.startsWith('$') ? refs[raw] : raw;
    if (!id) fail(`${label} "${raw}" refers to a node that is not added earlier in this proposal.`);
    const node = byId().get(id);
    if (!node) fail(`${label} "${raw}" is not a node on the canvas.`);
    if (types && !types.includes(node.type)) fail(`${label} "${raw}" is a ${node.type}, not a ${types.join(' or ')}.`);
    return node;
  }

  function registerRef(op, nodeId) {
    const ref = clean(op.ref);
    if (!ref) return;
    if (!ref.startsWith('$')) fail(`ref "${ref}" must start with "$".`);
    if (refs[ref]) fail(`ref "${ref}" is used twice.`);
    refs[ref] = nodeId;
  }

  function takenNames(type, filter = () => true) {
    return new Set(next.nodes.filter((n) => n.type === type && filter(n)).map((n) => nodeTitle(n)));
  }

  /** A free spot to the right of `anchor`, or below everything when there is no anchor. */
  function placeNear(anchor) {
    const occupied = next.nodes.map((n) => ({ left: Number(n.left) || 0, top: Number(n.top) || 0 }));
    const overlaps = (left, top) => occupied.some((o) => Math.abs(o.left - left) < NODE_WIDTH - 20 && Math.abs(o.top - top) < NODE_HEIGHT - 20);
    let left;
    let top;
    if (anchor) {
      left = (Number(anchor.left) || 0) + NODE_WIDTH;
      top = Number(anchor.top) || 0;
    } else {
      left = occupied.length ? Math.min(...occupied.map((o) => o.left)) : 80;
      top = occupied.length ? Math.max(...occupied.map((o) => o.top)) + NODE_HEIGHT + 40 : 80;
    }
    while (overlaps(left, top)) top += NODE_HEIGHT;
    return { left, top };
  }

  function addNode(node) {
    next.nodes.push(node);
    touched.add(node.nodeId);
    return node;
  }

  function connect(fromId, toId, type) {
    if (!next.connections.some((c) => c.fromId === fromId && c.toId === toId && c.type === type)) {
      next.connections.push({ fromId, toId, type });
    }
  }

  function disconnectWhere(predicate) {
    next.connections = next.connections.filter((c) => !predicate(c));
  }

  // ---------- normalizers for operation payloads ----------

  function normalizeSections(value) {
    if (!Array.isArray(value) || value.length === 0) fail('sections must be a non-empty list of {name, content}.');
    const sections = value.map((s) => ({ name: clean(s?.name), content: String(s?.content ?? '') }));
    if (sections.some((s) => !s.name)) fail('Every section needs a name.');
    if (!sections.some((s) => s.content.trim())) fail('The prompt has no content.');
    return sections;
  }

  /** Replace sections by name, or append ones with a new name; the rest stay as they are. */
  function editSections(current, edits) {
    if (!Array.isArray(edits) || edits.length === 0) fail('section_edits must be a non-empty list of {name, content}.');
    const sections = (current || []).map((s) => ({ name: String(s.name ?? ''), content: String(s.content ?? '') }));
    for (const edit of edits) {
      const name = clean(edit?.name);
      if (!name) fail('Every section edit needs the section name.');
      const target = sections.find((s) => s.name === name);
      if (target) target.content = String(edit?.content ?? '');
      else sections.push({ name, content: String(edit?.content ?? '') });
    }
    return normalizeSections(sections);
  }

  function nextSections(current, op) {
    if (op.sections != null && op.section_edits != null) fail('Give either sections or section_edits, not both.');
    if (op.section_edits != null) return editSections(current, op.section_edits);
    if (op.sections != null) return normalizeSections(op.sections);
    return null;
  }

  /**
   * An output schema from the model. A bare list is taken as the fields; for a version or an edit
   * (`base` = the current schema), whatever is left out (the fields, or the return shape) is kept.
   */
  function normalizeOutput(rawValue, base = null) {
    const value = Array.isArray(rawValue) ? { fields: rawValue } : rawValue;
    if (!value || typeof value !== 'object') fail('output must be {return_shape, fields}.');
    const returnShape = clean(value.return_shape ?? value.returnShape) || base?.returnShape || 'single';
    if (!RETURN_SHAPES.includes(returnShape)) fail(`return_shape must be ${RETURN_SHAPES.join(' or ')}.`);
    const rawFields = Array.isArray(value.fields) && value.fields.length ? value.fields : (base?.fields || []);
    const fields = rawFields.map((f) => ({
      key: clean(f?.key),
      type: clean(f?.type) || 'str',
      description: String(f?.description ?? '').trim(),
      examples: Array.isArray(f?.examples) ? f.examples.map((e) => String(e ?? '')).filter(Boolean) : [],
    }));
    if (!fields.length) fail('output.fields must list at least one field as {key, type, description}.');
    const keys = new Set();
    for (const f of fields) {
      if (!f.key) fail('Every output field needs a key.');
      if (keys.has(f.key)) fail(`Output field "${f.key}" is listed twice.`);
      keys.add(f.key);
      if (!OUTPUT_TYPES.includes(f.type)) fail(`Output field "${f.key}" has type "${f.type}"; use one of ${OUTPUT_TYPES.join(', ')}.`);
    }
    return { returnShape, fields };
  }

  function normalizeInputTypes(value, sections) {
    const names = ctx.extractInputFields(sections);
    const types = value && typeof value === 'object' ? value : {};
    for (const [name, type] of Object.entries(types)) {
      if (!names.includes(name)) fail(`input_types names "${name}", which is not a {variable} in the sections.`);
      if (!INPUT_TYPES.includes(type)) fail(`Input "${name}" has type "${type}"; use text, image or pdf.`);
    }
    return Object.fromEntries(Object.entries(types).filter(([, type]) => type !== 'text'));
  }

  function normalizeTable(op) {
    const columns = (Array.isArray(op.columns) ? op.columns : []).map((c) => clean(typeof c === 'object' ? c?.name : c));
    if (!columns.length || columns.some((c) => !c)) fail('columns must be a non-empty list of column names.');
    if (new Set(columns).size !== columns.length) fail('Column names must be unique.');
    const rows = (Array.isArray(op.rows) ? op.rows : []).map((row, i) => {
      if (Array.isArray(row)) {
        if (row.length !== columns.length) fail(`Row ${i + 1} has ${row.length} cells but there are ${columns.length} columns.`);
        return row.map((cell) => String(cell ?? ''));
      }
      if (row && typeof row === 'object') return columns.map((c) => String(row[c] ?? ''));
      return fail(`Row ${i + 1} must be a list of cells or an object keyed by column.`);
    });
    return { headers: columns, rows };
  }

  function validateMapping(prompt, dataset, mapping) {
    const inputs = promptInputs(prompt, ctx.extractInputFields);
    const columns = datasetColumns(dataset);
    const normalized = Object.fromEntries(Object.entries(mapping && typeof mapping === 'object' ? mapping : {})
      .map(([k, v]) => [clean(k), clean(v)]));
    for (const key of Object.keys(normalized)) {
      if (!inputs.some((i) => i.name === key)) fail(`input_mapping names "${key}", which is not an input of prompt "${nodeTitle(prompt)}".`);
    }
    for (const input of inputs) {
      const column = normalized[input.name];
      if (!column) fail(`input_mapping has no column for prompt input "${input.name}".`);
      const col = columns.find((c) => c.name === column);
      if (!col) fail(`Dataset "${nodeTitle(dataset)}" has no column "${column}". Columns: ${columns.map((c) => c.name).join(', ')}.`);
      if (col.type !== input.type) fail(`Prompt input "${input.name}" is ${input.type} but column "${column}" is ${col.type}.`);
    }
    return normalized;
  }

  function matchFlags(match) {
    const flags = {};
    const m = match && typeof match === 'object' ? match : {};
    for (const [key, flag] of Object.entries(MATCH_FLAG_KEYS)) if (m[key] === true) flags[flag] = true;
    const numeric = clean(m.numeric);
    if (numeric && numeric !== 'exact') {
      if (!['abs', 'rel', 'decimals'].includes(numeric)) fail('match.numeric must be exact, abs, rel or decimals.');
      flags.numericMode = numeric;
      if (numeric === 'abs') flags.numericAbsEpsilon = Number(m.tolerance) || 0;
      if (numeric === 'rel') flags.numericRelEpsilon = Number(m.tolerance) || 0;
      if (numeric === 'decimals') flags.numericDecimalPlaces = Number.isInteger(m.decimals) ? m.decimals : 2;
    }
    return flags;
  }

  function scoreBundle(op, run, groundTruth) {
    const prompt = next.nodes.find((n) => n.type === 'prompt'
      && next.connections.some((c) => c.type === 'prompt-to-run' && c.fromId === n.nodeId && c.toId === run.nodeId));
    const runDataset = byId().get(runInputSource(next, run.nodeId)?.nodeId);
    const inputColumns = runDataset ? datasetColumns(runDataset).map((c) => c.name) : [];
    const outputKeys = (prompt?.outputFormat?.fields || []).map((f) => f.key);
    const gtColumns = datasetColumns(groundTruth).map((c) => c.name);
    const gtList = (value, where) => {
      const cols = (Array.isArray(value) ? value : [value]).map(clean).filter(Boolean);
      if (!cols.length) fail(`${where} needs ground_truth_columns.`);
      for (const col of cols) {
        if (!gtColumns.includes(col)) fail(`Ground truth "${nodeTitle(groundTruth)}" has no column "${col}". Columns: ${gtColumns.join(', ')}.`);
      }
      return cols;
    };
    const pairing = (Array.isArray(op.pairing) ? op.pairing : []).map((rule, i) => {
      const column = clean(rule?.run_input_column);
      if (column !== '#' && !inputColumns.includes(column)) {
        fail(`pairing rule ${i + 1}: the run's input has no column "${column}". Use one of: ${inputColumns.join(', ')}, or "#" for the row number.`);
      }
      return {
        type: 'rule',
        outputKey: column === '#' ? '#' : `[${column}]`,
        gtColumns: gtList(rule?.ground_truth_columns, `pairing rule ${i + 1}`),
        matchType: 'exact',
        matchFlags: matchFlags(rule?.match),
      };
    });
    const comparison = (Array.isArray(op.comparison) ? op.comparison : []).map((rule, i) => {
      const field = clean(rule?.field);
      if (!outputKeys.includes(field)) fail(`comparison rule ${i + 1}: the prompt has no output field "${field}". Fields: ${outputKeys.join(', ')}.`);
      return {
        type: 'rule',
        outputKey: field,
        gtColumns: gtList(rule?.ground_truth_columns, `comparison rule ${i + 1}`),
        matchType: 'exact',
        matchFlags: matchFlags(rule?.match),
      };
    });
    if (!comparison.length) fail('A score needs at least one comparison rule.');
    const combine = clean(op.combine) || 'all';
    if (!['all', 'any'].includes(combine)) fail('combine must be "all" or "any".');
    const op2 = combine === 'all' ? 'AND' : 'OR';
    const { inputRoot, outputRoot } = parseScoreMappingBundle({
      v: 2,
      input: { type: 'group', ops: Array(Math.max(0, pairing.length - 1)).fill('AND'), children: pairing },
      output: { type: 'group', ops: Array(comparison.length - 1).fill(op2), children: comparison },
    });
    return {
      mapping: JSON.parse(serializeScoreMappingBundle(inputRoot, outputRoot)),
      lines: [
        ...pairing.map((r) => `Pair rows: ${r.outputKey === '#' ? 'row number' : r.outputKey.slice(1, -1)} = ${r.gtColumns.join(' / ')}`),
        ...comparison.map((r) => `Compare ${r.outputKey} with ${r.gtColumns.join(' / ')}`),
        comparison.length > 1 ? `A row matches when ${combine === 'all' ? 'all' : 'any'} comparisons match` : null,
      ].filter(Boolean),
    };
  }

  /** Like the Process window: the inputs are df and each Dataset the code declares as a process()
   * parameter or uses, by the alias it already has. Returns the inputs other than df. */
  function wireProcess(processNode, code, primary) {
    if (!/^\s*def\s+process\s*\(\s*df\b/m.test(code)) fail('Process code must define process(df).');
    // The Agent reads and writes Dataset inputs only until it learns step outputs (DATA_FLOW_PLAN.md step 13).
    const bindings = processInputBindings(next, processNode.nodeId, { code, primaryId: primary.nodeId })
      .filter((binding) => binding.kind === 'dataset');
    const unknown = [...referencedDatasetAliasNames(code)]
      .filter((alias) => !bindings.some((b) => b.alias === alias));
    if (unknown.length) {
      fail(`The code uses ${unknown.join(', ')}, which match no dataset. Available: ${bindings.filter((b) => !b.primary).map((b) => b.alias).join(', ') || '(none)'}.`);
    }
    const inputs = bindings.filter((b) => b.input);
    processNode.dfCode = code;
    processNode.activeMode = 'df';
    setProcessInputs(next, processNode.nodeId, { primary: { nodeId: primary.nodeId, port: RESULT_PORT }, inputs });
    return inputs.filter((b) => !b.primary);
  }

  function sampleRows(rows, op) {
    const mode = clean(op.sampling) || 'random';
    if (mode === 'rows') {
      const spec = clean(op.rows);
      if (!spec) fail('sampling "rows" needs rows, for example "1 3 5-10".');
      const indices = [];
      for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
        const [a, b] = part.split('-').map((x) => parseInt(x, 10));
        if (!Number.isFinite(a) || a < 1 || (part.includes('-') && (!Number.isFinite(b) || b < 1))) fail(`"${part}" is not a row number or range.`);
        const hi = part.includes('-') ? Math.max(a, b) : a;
        for (let r = Math.min(a, hi); r <= Math.min(hi, rows.length); r += 1) indices.push(r - 1);
      }
      return { sampler: { samplingType: 'specify-rows', rowSpec: spec }, rows: indices.map((i) => rows[i]), label: `rows ${spec}` };
    }
    if (!['random', 'random_with_replacement'].includes(mode)) fail('sampling must be random, random_with_replacement or rows.');
    const unit = clean(op.size_unit) || 'rows';
    if (!['rows', 'percent'].includes(unit)) fail('size_unit must be rows or percent.');
    const size = Math.floor(Number(op.size));
    if (!Number.isFinite(size) || size < 1 || (unit === 'percent' && size > 100)) fail('size must be a positive number (at most 100 for percent).');
    const count = Math.min(rows.length, unit === 'rows' ? size : Math.floor((rows.length * size) / 100));
    const withReplacement = mode === 'random_with_replacement';
    let picked;
    if (withReplacement) {
      picked = Array.from({ length: count }, () => Math.floor(Math.random() * rows.length)).sort((a, b) => a - b);
    } else {
      const order = rows.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      picked = order.slice(0, count).sort((a, b) => a - b);
    }
    return {
      sampler: {
        samplingType: withReplacement ? 'with-replacement' : 'without-replacement',
        sampleSizeType: unit === 'rows' ? 'rows' : 'ratio',
        sampleSize: size,
      },
      rows: picked.map((i) => rows[i]),
      label: `${count} random rows${withReplacement ? ' (with replacement)' : ''}`,
    };
  }

  // ---------- operations ----------

  const handlers = {
    add_dataset(op) {
      const { headers, rows } = normalizeTable(op);
      const name = uniqueName(clean(op.name) || 'Dataset', takenNames('dataset'));
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(null),
        name,
        note: String(op.note ?? ''),
        datasetContent: normalizeDatasetContent({ headers, rows }),
        nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      return { kind: 'add', type: 'dataset', title: `New dataset "${name}"`, nodeIds: [node.nodeId],
        lines: [`${rows.length} rows; columns: ${headers.join(', ')}`] };
    },

    import_dataset(op, index) {
      const sourceKey = clean(op.source);
      const source = ctx.sources?.[sourceKey];
      if (!source) fail(`source must be one of: ${Object.keys(ctx.sources || {}).join(', ')}.`);
      const ids = (Array.isArray(op.ids) ? op.ids : []).map(clean).filter(Boolean);
      if (!ids.length) fail(`ids must list the ${source.id}s to import.`);
      if (ids.length > 5000) fail('At most 5000 records can be imported at once.');
      const fields = (Array.isArray(op.fields) ? op.fields : []).map(clean).filter(Boolean);
      const unknown = fields.filter((f) => !source.fields[f]);
      if (!fields.length || unknown.length) {
        fail(`fields must be chosen from: ${Object.keys(source.fields).join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}.`);
      }
      const fetched = ctx.imported?.get(index);
      const headers = fetched ? fetched.headers : fields.map((f) => source.fields[f]);
      const rows = fetched ? fetched.rows : [];
      const name = uniqueName(clean(op.name) || `${source.label} import`, takenNames('dataset'));
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(null),
        name,
        note: String(op.note ?? `Imported from ${source.label}.`),
        datasetContent: normalizeDatasetContent({ headers, rows }),
        nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      const lines = [`${ids.length} ${source.id}${ids.length === 1 ? '' : 's'} from ${source.label}; columns: ${headers.join(', ')}`];
      if (fetched?.notFound?.length) lines.push(`${fetched.notFound.length} not found: ${fetched.notFound.slice(0, 10).join(', ')}`);
      if (!fetched) lines.push('Records are fetched when the proposal is applied.');
      return { kind: 'add', type: 'dataset', title: `Import "${name}"`, nodeIds: [node.nodeId], lines };
    },

    add_sampler(op) {
      const source = resolve(op.source, 'source', ['dataset']);
      const content = normalizeDatasetContent(source.datasetContent || { headers: [], rows: [] });
      if (!content.rows.length) fail(`Dataset "${nodeTitle(source)}" has no rows to sample.`);
      const sample = sampleRows(content.rows, op);
      const samplerName = uniqueName(clean(op.name) || 'Sample', takenNames('sampler', (n) => n.sourceNodeId === source.nodeId));
      const sampler = addNode({
        type: 'sampler',
        nodeId: generateNodeId(),
        ...placeNear(source),
        name: samplerName,
        note: '',
        sourceNodeId: source.nodeId,
        ...sample.sampler,
        nodeOrigin: 'agent',
      });
      connect(source.nodeId, sampler.nodeId, 'dataset-to-sampler');
      const datasetName = uniqueName(clean(op.dataset_name) || `${nodeTitle(source)} ${samplerName}`, takenNames('dataset'));
      const dataset = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(sampler),
        name: datasetName,
        note: '',
        samplerNodeId: sampler.nodeId,
        datasetContent: normalizeDatasetContent({
          headers: content.headers,
          columnTypes: content.columnTypes,
          rows: sample.rows,
        }),
        nodeOrigin: 'agent',
      });
      connect(sampler.nodeId, dataset.nodeId, 'sampler-to-dataset');
      registerRef(op, sampler.nodeId);
      if (clean(op.dataset_ref)) registerRef({ ref: op.dataset_ref }, dataset.nodeId);
      return { kind: 'add', type: 'sampler', title: `New sample "${datasetName}" of "${nodeTitle(source)}"`,
        nodeIds: [sampler.nodeId, dataset.nodeId], lines: [`${sample.label}, ${sample.rows.length} rows`] };
    },

    add_process(op) {
      const primary = resolve(op.primary_input, 'primary_input', ['dataset']);
      const code = String(op.code ?? '').trim();
      const name = uniqueName(clean(op.name) || 'Process', takenNames('process'));
      const node = addNode({ type: 'process', nodeId: generateNodeId(), ...placeNear(primary), name, nodeOrigin: 'agent' });
      const others = wireProcess(node, code, primary);
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'process', title: `New process "${name}"`, nodeIds: [node.nodeId],
        lines: [`df = "${nodeTitle(primary)}"`, ...others.map((b) => `${b.alias} = "${b.name}"`),
          'Not run yet: running it produces its output branches.'],
        diffs: [{ label: 'Code', before: '', after: code }],
      };
    },

    add_prompt(op) {
      const sections = normalizeSections(op.sections);
      const outputFormat = normalizeOutput(op.output);
      const inputTypes = normalizeInputTypes(op.input_types, sections);
      const name = uniqueName(clean(op.name) || 'Prompt', takenNames('prompt'));
      const node = addNode({
        type: 'prompt', nodeId: generateNodeId(), ...placeNear(null), name, note: String(op.note ?? ''),
        sections, outputFormat, inputTypes, nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'prompt', title: `New prompt "${name}"`, nodeIds: [node.nodeId],
        lines: [`Inputs: ${promptInputs(node, ctx.extractInputFields).map((i) => `${i.name} (${i.type})`).join(', ') || '(none)'}`],
        diffs: [
          { label: 'Sections', before: '', after: sectionsText(sections) },
          { label: 'Output', before: '', after: outputText(outputFormat) },
        ],
      };
    },

    add_prompt_version(op) {
      const source = resolve(op.prompt, 'prompt', ['prompt']);
      const sections = nextSections(source.sections, op) || source.sections.map((s) => ({ ...s }));
      const outputFormat = op.output != null ? normalizeOutput(op.output, source.outputFormat) : JSON.parse(JSON.stringify(source.outputFormat || { returnShape: 'single', fields: [] }));
      const inputTypes = op.input_types != null
        ? normalizeInputTypes(op.input_types, sections)
        : Object.fromEntries(Object.entries(source.inputTypes || {}).filter(([k]) => ctx.extractInputFields(sections).includes(k)));
      const name = uniqueName(clean(op.name) || nodeTitle(source), takenNames('prompt'));
      const node = addNode({
        type: 'prompt', nodeId: generateNodeId(), ...placeNear(source), name,
        note: op.note != null ? String(op.note) : String(source.note || ''),
        sections, outputFormat, inputTypes, nodeOrigin: 'agent',
      });
      connect(source.nodeId, node.nodeId, 'prompt-to-prompt');
      registerRef(op, node.nodeId);
      const diffs = [];
      if (op.sections != null || op.section_edits != null) diffs.push({ label: 'Sections', before: sectionsText(source.sections), after: sectionsText(sections) });
      if (op.output != null) diffs.push({ label: 'Output', before: outputText(source.outputFormat), after: outputText(outputFormat) });
      return { kind: 'add', type: 'prompt', title: `New version "${name}" of "${nodeTitle(source)}"`, nodeIds: [node.nodeId],
        lines: diffs.length ? [] : ['Same content as the source prompt.'], diffs };
    },

    add_run(op) {
      const prompt = resolve(op.prompt, 'prompt', ['prompt']);
      const dataset = resolve(op.input_dataset, 'input_dataset', ['dataset']);
      const mapping = validateMapping(prompt, dataset, op.input_mapping);
      // Like the user, the Agent has no per-Run model or settings: Runs use Settings → Run defaults.
      if (op.credential_id != null || op.settings != null) fail('A Run uses the default Run model and settings from Settings; credential_id and settings cannot be set per Run.');
      const runsOfPrompt = new Set(next.connections.filter((c) => c.type === 'prompt-to-run' && c.fromId === prompt.nodeId).map((c) => c.toId));
      const name = uniqueName(clean(op.name) || 'Run', takenNames('run', (n) => runsOfPrompt.has(n.nodeId)));
      const node = addNode({
        type: 'run', nodeId: generateNodeId(), ...placeNear(prompt), runName: name,
        runInputToColumn: JSON.stringify(mapping),
        nodeOrigin: 'agent',
      });
      setRunInputSource(next, node.nodeId, { nodeId: dataset.nodeId, port: RESULT_PORT });
      connect(prompt.nodeId, node.nodeId, 'prompt-to-run');
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'run', title: `New run "${name}"`, nodeIds: [node.nodeId],
        lines: [
          `Prompt "${nodeTitle(prompt)}" on "${nodeTitle(dataset)}"`,
          `Mapping: ${Object.entries(mapping).map(([k, v]) => `${k} ← ${v}`).join(', ') || '(no inputs)'}`,
          'Model and settings: Settings → Run defaults',
          'Not started: it runs when you start it.',
        ],
      };
    },

    add_score(op) {
      const run = resolve(op.run, 'run', ['run']);
      const groundTruth = resolve(op.ground_truth, 'ground_truth', ['dataset']);
      const name = uniqueName(clean(op.name) || 'Score', takenNames('score'));
      const node = addNode({
        type: 'score', nodeId: generateNodeId(), ...placeNear(run), scoreName: name,
        scoreGroundTruthId: groundTruth.nodeId, nodeOrigin: 'agent',
      });
      let lines;
      if (clean(op.match_code)) {
        if (!/^\s*def\s+match\s*\(/m.test(op.match_code)) fail('match_code must define match(input_row, output_row, gt_row).');
        node.scoreActiveMatchMode = 'code';
        node.scoreMatchCode = String(op.match_code);
        lines = ['Matches rows with custom match code'];
      } else {
        const bundle = scoreBundle(op, run, groundTruth);
        node.scoreMapping = bundle.mapping;
        lines = bundle.lines;
      }
      if (op.review_method != null) fail('A Review uses the review method from Settings → Review defaults; review_method cannot be set per Score.');
      connect(run.nodeId, node.nodeId, 'run-to-score');
      registerRef(op, node.nodeId);
      return { kind: 'add', type: 'score', title: `New score "${name}"`, nodeIds: [node.nodeId],
        lines: [`Run "${nodeTitle(run)}" vs ground truth "${nodeTitle(groundTruth)}"`, ...lines],
        diffs: node.scoreMatchCode ? [{ label: 'Match code', before: '', after: node.scoreMatchCode }] : [] };
    },

    update(op) {
      const node = resolve(op.node, 'node');
      const set = op.set && typeof op.set === 'object' ? op.set : fail('update needs set: {field: value}.');
      const keys = Object.keys(set);
      if (!keys.length) fail('set is empty.');
      touched.add(node.nodeId);
      const before = nodeTitle(node);
      const lines = [];
      const diffs = [];
      const allowed = {
        prompt: ['name', 'note', 'sections', 'section_edits', 'input_types', 'output'],
        dataset: ['name', 'note', 'columns', 'rows'],
        process: ['name', 'code', 'primary_input'],
        run: ['name', 'prompt', 'input_dataset', 'input_mapping'],
        score: ['name', 'ground_truth', 'pairing', 'comparison', 'combine', 'match_code'],
        sampler: ['name'],
        promptReview: ['name'],
      }[node.type] || [];
      const bad = keys.filter((k) => !allowed.includes(k));
      if (bad.length) fail(`A ${node.type} cannot set ${bad.join(', ')}. Settable: ${allowed.join(', ')}.`);

      if ('name' in set) {
        const name = clean(set.name);
        if (!name) fail('name cannot be empty.');
        const field = { prompt: 'name', dataset: 'name', process: 'name', sampler: 'name', run: 'runName', score: 'scoreName', promptReview: 'promptReviewName' }[node.type];
        const taken = takenNames(node.type, (n) => n.nodeId !== node.nodeId);
        if (['prompt', 'dataset'].includes(node.type) && taken.has(name)) fail(`Another ${node.type} is already called "${name}".`);
        node[field] = name;
        lines.push(`Rename to "${name}"`);
      }
      if ('note' in set) {
        node.note = String(set.note ?? '');
        lines.push('Update the note');
      }

      // Content that has produced results is locked (contentLocks.js), as in the node windows.
      const contentKeys = { prompt: ['sections', 'section_edits', 'input_types', 'output'], dataset: ['columns', 'rows'] }[node.type] || [];
      if (ctx.contentLocks?.get(node.nodeId)?.length && contentKeys.some((k) => k in set)) {
        const remedy = {
          prompt: 'Use add_prompt_version to change a new version.',
          dataset: 'Add a new dataset (add_dataset) with the changed table instead.',
        }[node.type];
        fail(`${node.type[0].toUpperCase()}${node.type.slice(1)} "${before}" has produced results, so its content is locked. ${remedy}`);
      }

      if (node.type === 'prompt') {
        if ('sections' in set || 'section_edits' in set) {
          const sections = nextSections(node.sections, set);
          diffs.push({ label: 'Sections', before: sectionsText(node.sections), after: sectionsText(sections) });
          node.sections = sections;
          node.inputTypes = Object.fromEntries(Object.entries(node.inputTypes || {}).filter(([k]) => ctx.extractInputFields(sections).includes(k)));
        }
        if ('input_types' in set) node.inputTypes = normalizeInputTypes(set.input_types, node.sections);
        if ('output' in set) {
          const outputFormat = normalizeOutput(set.output, node.outputFormat);
          diffs.push({ label: 'Output', before: outputText(node.outputFormat), after: outputText(outputFormat) });
          node.outputFormat = outputFormat;
        }
      }

      if (node.type === 'dataset' && ('columns' in set || 'rows' in set)) {
        // Like the dataset window: an older output that still follows History becomes a saved copy when edited.
        const historySource = next.historyVersion === 1 ? datasetHistorySource(node, next.connections) : null;
        if (historySource) {
          const recordId = clean(byId().get(historySource.sourceId)?.historyRecordId);
          if (!recordId) fail(`Dataset "${nodeTitle(node)}" follows History, but its ${historySource.kind} has no History record. Run it again before editing this table.`);
          node.savedCopy = true;
          node.snapshotSourceRecordId = recordId;
          lines.push('Becomes a saved copy: History no longer replaces its table.');
        }
        if (datasetColumns(node).some((c) => c.type !== 'text')) fail('Datasets with image or pdf columns cannot be rewritten here; edit them in the dataset view.');
        const current = normalizeDatasetContent(node.datasetContent || { headers: [], rows: [] });
        const { headers, rows } = normalizeTable({ columns: set.columns ?? current.headers, rows: set.rows ?? current.rows });
        lines.push(`Replace the table: ${current.rows.length} → ${rows.length} rows; columns: ${headers.join(', ')}`);
        node.datasetContent = normalizeDatasetContent({ headers, rows });
      }

      if (node.type === 'process' && ('code' in set || 'primary_input' in set)) {
        const primary = 'primary_input' in set
          ? resolve(set.primary_input, 'primary_input', ['dataset'])
          : resolve(processPrimarySource(next, node.nodeId)?.nodeId, 'primary input', ['dataset']);
        const code = 'code' in set ? String(set.code ?? '').trim() : String(node.dfCode || '');
        if ('code' in set) diffs.push({ label: 'Code', before: String(node.dfCode || ''), after: code });
        if ('primary_input' in set) lines.push(`df = "${nodeTitle(primary)}"`);
        wireProcess(node, code, primary);
        if (node.dfResults) lines.push('Its last output no longer reflects the code until it is run again.');
      }

      if (node.type === 'run') {
        if (node.runPending) fail(`Run "${before}" is running; stop it before changing it.`);
        if ('prompt' in set || 'input_dataset' in set || 'input_mapping' in set) {
          // Like the Run window: a Run picks its Prompt and Dataset, and both lock once it has results.
          if (next.historyVersion !== 1 && (runResultsExist(node) || node.runCompleted === true || node.runCompleted === '1')) {
            fail(`Run "${before}" already has results, so its prompt, input and mapping are fixed. Add a new run (add_run) instead.`);
          }
          const currentPromptId = next.connections.find((c) => c.type === 'prompt-to-run' && c.toId === node.nodeId)?.fromId;
          const prompt = 'prompt' in set
            ? resolve(set.prompt, 'prompt', ['prompt'])
            : resolve(currentPromptId, 'the run\'s prompt', ['prompt']);
          const dataset = 'input_dataset' in set
            ? resolve(set.input_dataset, 'input_dataset', ['dataset'])
            : resolve(runInputSource(next, node.nodeId)?.nodeId, 'the run\'s input dataset', ['dataset']);
          // A new Prompt keeps only the old mapping for inputs it shares, as the Run window does.
          const promptInputNames = new Set(promptInputs(prompt, ctx.extractInputFields).map((input) => input.name));
          const keptMapping = Object.fromEntries(Object.entries(parseJson(node.runInputToColumn, {}))
            .filter(([name]) => prompt.nodeId === currentPromptId || promptInputNames.has(name)));
          const mapping = validateMapping(prompt, dataset, set.input_mapping ?? keptMapping);
          if (prompt.nodeId !== currentPromptId) {
            disconnectWhere((c) => c.type === 'prompt-to-run' && c.toId === node.nodeId);
            connect(prompt.nodeId, node.nodeId, 'prompt-to-run');
            lines.push(`Prompt "${nodeTitle(prompt)}"`);
          }
          setRunInputSource(next, node.nodeId, { nodeId: dataset.nodeId, port: RESULT_PORT });
          node.runInputToColumn = JSON.stringify(mapping);
          lines.push(`Input "${nodeTitle(dataset)}"; mapping: ${Object.entries(mapping).map(([k, v]) => `${k} ← ${v}`).join(', ')}`);
        }
      }

      if (node.type === 'score') {
        if ('ground_truth' in set) {
          const gt = resolve(set.ground_truth, 'ground_truth', ['dataset']);
          node.scoreGroundTruthId = gt.nodeId;
          lines.push(`Ground truth "${nodeTitle(gt)}"`);
        }
        if ('match_code' in set) {
          const code = String(set.match_code ?? '');
          if (code.trim()) {
            if (!/^\s*def\s+match\s*\(/m.test(code)) fail('match_code must define match(input_row, output_row, gt_row).');
            diffs.push({ label: 'Match code', before: String(node.scoreMatchCode || ''), after: code });
            node.scoreMatchCode = code;
            node.scoreActiveMatchMode = 'code';
          } else {
            delete node.scoreActiveMatchMode;
            lines.push('Match with rules instead of code');
          }
        }
        if ('pairing' in set || 'comparison' in set || 'combine' in set) {
          if (!('comparison' in set)) fail('Changing score rules needs the full comparison list.');
          const run = resolve(next.connections.find((c) => c.type === 'run-to-score' && c.toId === node.nodeId)?.fromId, 'the score\'s run', ['run']);
          const gt = resolve(node.scoreGroundTruthId, 'the score\'s ground truth', ['dataset']);
          const bundle = scoreBundle(set, run, gt);
          node.scoreMapping = bundle.mapping;
          delete node.scoreActiveMatchMode;
          lines.push(...bundle.lines);
        }
        if (['ground_truth', 'match_code', 'pairing', 'comparison', 'combine'].some((k) => k in set) && node.reviewResult) {
          lines.push('Its saved comparison is recomputed from the new settings.');
          const saved = parseJson(node.reviewResult, {});
          delete saved.comparison_rows;
          node.reviewResult = JSON.stringify(saved);
        }
      }

      return { kind: 'update', type: node.type, title: `Change ${node.type === 'promptReview' ? 'review' : node.type} "${before}"`, nodeIds: [node.nodeId], lines, diffs };
    },

    save_run_results(op) {
      const run = resolve(op.run, 'run', ['run']);
      if (run.runPending) fail(`Run "${nodeTitle(run)}" is still running; save its results once it finishes.`);
      const results = runResultsOf(run);
      if (!results.length) fail(`Run "${nodeTitle(run)}" has no results yet.`);
      const recordId = clean(run.historyRecordId);
      if (!recordId) fail(`Run "${nodeTitle(run)}" has no History record. Run it again before saving its results.`);
      const prompt = byId().get(next.connections.find((c) => c.type === 'prompt-to-run' && c.toId === run.nodeId)?.fromId);
      const saved = runInputContentOf(run);
      const runContent = Array.isArray(saved.rows) && saved.rows.length
        ? saved
        : normalizeDatasetContent(byId().get(runInputSource(next, run.nodeId)?.nodeId)?.datasetContent || { headers: [], rows: [] });
      const table = buildRunResultsTable({ results, runContent, schemaFields: prompt?.outputFormat?.fields || [] });
      const completed = run.runCompleted === true || run.runCompleted === '1';
      const promptName = prompt ? nodeTitle(prompt) : 'Prompt';
      const name = uniqueName(clean(op.name) || `${promptName} ${nodeTitle(run)}`, takenNames('dataset'));
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(run),
        name,
        note: String(op.note ?? `Exported from ${promptName} ${nodeTitle(run)}.\n${completed ? 'Run completed.' : 'Run incomplete.'}`),
        sourceRunNodeId: run.nodeId,
        // A saved output is a copy, as in the UI: History never rewrites it (datasetHistorySource.js).
        savedCopy: true,
        snapshotSourceRecordId: recordId,
        datasetContent: normalizeDatasetContent(table),
        nodeOrigin: 'agent',
      });
      registerRef(op, node.nodeId);
      const lines = [`${table.rows.length} rows from run "${nodeTitle(run)}"; ${table.headers.length} columns`];
      if (!completed) lines.push('The run did not finish, so only the rows it produced are saved.');
      return { kind: 'add', type: 'dataset', title: `Save the results of run "${nodeTitle(run)}" as "${name}"`, nodeIds: [node.nodeId], lines };
    },

    save_process_output(op) {
      const processNode = resolve(op.process, 'process', ['process']);
      const outputs = processOutputsOf(processNode);
      const branches = Object.keys(outputs);
      if (!branches.length) fail(`Process "${nodeTitle(processNode)}" has no output yet. Run it first.`);
      const branch = clean(op.branch) || (branches.length === 1 ? branches[0] : '');
      if (!branch) fail(`Process "${nodeTitle(processNode)}" has several branches (${branches.join(', ')}); name the branch to save.`);
      if (!outputs[branch]) fail(`Process "${nodeTitle(processNode)}" has no branch "${branch}". Branches: ${branches.join(', ')}.`);
      const recordId = clean(processNode.historyRecordId);
      if (!recordId) fail(`Process "${nodeTitle(processNode)}" has no History record. Run it again before saving its output.`);
      const title = nodeTitle(processNode);
      const name = uniqueName(clean(op.name) || (branches.length === 1 ? `${title} results` : `${title} — ${branch}`), takenNames('dataset'));
      const content = normalizeDatasetContent(outputs[branch]);
      const node = addNode({
        type: 'dataset',
        nodeId: generateNodeId(),
        ...placeNear(processNode),
        name,
        note: String(op.note ?? `Branch "${branch}" exported from Process "${title}".`),
        processOutputName: branch,
        savedCopy: true,
        snapshotSourceRecordId: recordId,
        datasetContent: content,
        nodeOrigin: 'agent',
      });
      connect(processNode.nodeId, node.nodeId, 'process-to-dataset');
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'dataset', title: `Save branch "${branch}" of process "${title}" as "${name}"`, nodeIds: [node.nodeId],
        lines: [`${content.rows.length} rows; columns: ${content.headers.join(', ')}`],
      };
    },

    apply_review(op) {
      const review = resolve(op.review, 'review', ['promptReview']);
      if (review.reviewPending) fail(`Review "${nodeTitle(review)}" is still running.`);
      const reviewResult = parseJson(review.reviewResult, {});
      const suggestions = Array.isArray(reviewResult.suggestions) ? reviewResult.suggestions : [];
      if (!suggestions.length) fail(`Review "${nodeTitle(review)}" has no suggestions.`);
      const ids = (Array.isArray(op.suggestion_ids) ? op.suggestion_ids : []).map(clean).filter(Boolean);
      if (!ids.length) fail('suggestion_ids must list the suggestions to apply.');
      const known = new Set(suggestions.map((s) => clean(s?.suggestion_id)));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length) fail(`Review "${nodeTitle(review)}" has no suggestion ${unknown.join(', ')}. Ids: ${[...known].join(', ')}.`);
      const score = byId().get(next.connections.find((c) => c.type === 'score-to-prompt-review' && c.toId === review.nodeId)?.fromId);
      const run = score ? byId().get(next.connections.find((c) => c.type === 'run-to-score' && c.toId === score.nodeId)?.fromId) : null;
      const source = run ? byId().get(next.connections.find((c) => c.type === 'prompt-to-run' && c.toId === run.nodeId)?.fromId) : null;
      if (!source) fail(`Review "${nodeTitle(review)}" is not connected through a score and run to a prompt.`);
      const originals = (Array.isArray(reviewResult.promptSections) && reviewResult.promptSections.length ? reviewResult.promptSections : source.sections)
        .map((s) => ({ name: String(s?.name ?? ''), content: String(s?.content ?? '') }));
      const chosen = new Set(ids);
      const marked = suggestions.map((s) => ({ ...s, applied: chosen.has(clean(s?.suggestion_id)) }));
      const sections = rebuildWorkingFromApplied(originals, marked);
      if (!sections || sectionsText(sections) === sectionsText(originals)) {
        fail('None of the chosen suggestions could be applied: their text no longer matches the prompt the review saw.');
      }
      const unverified = ids.filter((id) => (reviewResult.verify_states?.[id] || '') !== 'verified');
      if (unverified.length) warnings.push(`Not verified yet: suggestion ${unverified.join(', ')}. Its effect on the failing rows is unknown until the new version is run.`);
      review.reviewResult = JSON.stringify({ ...reviewResult, suggestions: marked, workingSections: sections });
      const name = uniqueName(clean(op.name) || nodeTitle(source), takenNames('prompt'));
      const node = addNode({
        type: 'prompt', nodeId: generateNodeId(), ...placeNear(review), name,
        note: String(op.note ?? `Created from review "${nodeTitle(review)}" (suggestions ${ids.join(', ')}).`),
        sections: normalizeSections(sections),
        outputFormat: JSON.parse(JSON.stringify(source.outputFormat || { returnShape: 'single', fields: [] })),
        inputTypes: { ...(source.inputTypes || {}) },
        nodeOrigin: 'agent',
      });
      connect(review.nodeId, node.nodeId, 'prompt-review-to-prompt');
      registerRef(op, node.nodeId);
      return {
        kind: 'add', type: 'prompt', title: `New prompt "${name}" from review "${nodeTitle(review)}"`, nodeIds: [node.nodeId],
        lines: [`Applies suggestion${ids.length === 1 ? '' : 's'} ${ids.join(', ')} to "${nodeTitle(source)}"`],
        diffs: [{ label: 'Sections', before: sectionsText(originals), after: sectionsText(sections) }],
      };
    },

    remove(op) {
      const node = resolve(op.node, 'node');
      if (node.type === 'run' && node.runPending) fail(`Run "${nodeTitle(node)}" is running; stop it before removing it.`);
      if (node.type === 'promptReview' && node.reviewPending) fail(`Review "${nodeTitle(node)}" is running; stop it before removing it.`);
      const id = node.nodeId;
      const lines = [];
      for (const other of next.nodes) {
        if (other.type === 'run' && runInputSource(next, other.nodeId)?.nodeId === id) {
          setRunInputSource(next, other.nodeId, null);
          lines.push(`Run "${nodeTitle(other)}" loses its input dataset`);
        }
        if (other.type === 'score' && other.scoreGroundTruthId === id) {
          delete other.scoreGroundTruthId;
          lines.push(`Score "${nodeTitle(other)}" loses its ground truth`);
        }
        if (other.type === 'process' && processPrimarySource(next, other.nodeId)?.nodeId === id) {
          setProcessPrimarySource(next, other.nodeId, null);
          lines.push(`Process "${nodeTitle(other)}" loses its primary input`);
        }
        if (other.type === 'dataset' && other.sourceRunNodeId === id) delete other.sourceRunNodeId;
        if (other.type === 'dataset' && other.samplerNodeId === id) delete other.samplerNodeId;
      }
      for (const c of next.connections) {
        if (c.fromId !== id && c.toId !== id) continue;
        const other = byId().get(c.fromId === id ? c.toId : c.fromId);
        if (other && ['prompt-to-run', 'run-to-score', 'score-to-prompt-review'].includes(c.type) && c.fromId === id) {
          lines.push(`${other.type === 'promptReview' ? 'Review' : other.type[0].toUpperCase() + other.type.slice(1)} "${nodeTitle(other)}" is disconnected`);
        }
      }
      disconnectWhere((c) => c.fromId === id || c.toId === id);
      next.nodes = next.nodes.filter((n) => n.nodeId !== id);
      return { kind: 'remove', type: node.type, title: `Remove ${node.type === 'promptReview' ? 'review' : node.type} "${nodeTitle(node)}"`, nodeIds: [id], lines };
    },
  };

  function runResultsExist(node) {
    const results = parseJson(node.runResults, []);
    return Array.isArray(results) && results.length > 0;
  }

  operations.forEach((op, index) => {
    const handler = handlers[clean(op?.op)];
    try {
      if (!handler) fail(`Unknown op "${clean(op?.op)}". Use one of: ${Object.keys(handlers).join(', ')}.`);
      const item = handler(op, index);
      items.push({ index, op: clean(op.op), diffs: [], lines: [], ...item });
    } catch (error) {
      if (error instanceof ChangeSetError && error.operationIndex == null) throw new ChangeSetError(error.message, index);
      throw error;
    }
  });

  const present = new Set(next.nodes.map((n) => n.nodeId));
  return { state: next, items, refs, warnings, nodeIds: [...touched].filter((id) => present.has(id)) };
}

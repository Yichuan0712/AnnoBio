/**
 * What Verify already uses (the evaluation payload's Generate model, run settings, match code and tables), sent with
 * the Optimize request so a method can run and score candidates in the backend exactly as Verify does (the AnnoBio
 * engine's worked-example card; backend/review_engine_hooks.py). Only the input and ground-truth rows this Optimize
 * refers to are sent, each at its original index. Nothing is added without a Generate model, and a backend that
 * does not know the fields ignores them.
 */
const RUN_SETTING_KEYS = ['run_max_tokens', 'run_max_retries', 'run_concurrency']; // backend RUN_SETTINGS_OVERRIDE_KEYS

export function reviewVerifyContext(payload, comparisonRows) {
  const runCredentialId = String(payload?.run_credential_id || '').trim();
  if (!runCredentialId) return {};
  const runWs = payload?.runWs || { headers: [], rows: [] };
  const gtContent = payload?.gtContent || { headers: [], rows: [] };
  const inputIdx = new Set();
  const gtIdx = new Set();
  for (const r of comparisonRows || []) {
    if (typeof r?.input_row_index === 'number' && !Number.isNaN(r.input_row_index)) inputIdx.add(r.input_row_index);
    if (typeof r?.source_gt_row_index === 'number' && !Number.isNaN(r.source_gt_row_index)) gtIdx.add(r.source_gt_row_index);
  }
  const pick = (rows, indices) => [...indices].sort((a, b) => a - b)
    .filter((i) => Number.isInteger(i) && i >= 0 && Array.isArray(rows) && i < rows.length)
    .map((i) => [i, rows[i]]);
  const settings = payload?.run_settings || {};
  const runSettings = Object.fromEntries(RUN_SETTING_KEYS.filter((k) => settings[k] != null).map((k) => [k, settings[k]]));
  return {
    run_credential_id: runCredentialId,
    run_settings: runSettings,
    score_match_code: payload?.score_match_code || '',
    score_tables: {
      input_headers: runWs.headers || [],
      input_rows: pick(runWs.rows, inputIdx),
      gt_headers: gtContent.headers || [],
      gt_rows: pick(gtContent.rows, gtIdx),
    },
  };
}

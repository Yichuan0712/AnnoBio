/**
 * Run / Resume 工具函数
 *
 * 约定：input_row_index 统一为 0-based（0,1,2...）
 * 展示时用 input_row_index + 1 显示给用户
 */

/**
 * 给每条 result 嵌入 input_row
 */
export function embedInputRow(results, content) {
  if (!Array.isArray(results)) return results;
  const rows = content?.rows;
  if (!Array.isArray(rows)) {
    return results.map((r) => (r.input_row != null ? r : { ...r, input_row: [] }));
  }
  return results.map((r) => {
    const idx = typeof r.input_row_index === 'number' && r.input_row_index >= 0 ? r.input_row_index : -1;
    if (idx < 0) return { ...r, input_row: r.input_row ?? [] };
    const row = rows[idx];
    return { ...r, input_row: Array.isArray(row) ? row.slice() : [] };
  });
}

/**
 * 已完成的不同 input 行数（用于进度条）
 */
export function countCompletedInputRows(results) {
  if (!Array.isArray(results)) return 0;
  const seen = new Set();
  for (const r of results) {
    if (typeof r.input_row_index === 'number' && r.input_row_index >= 0) seen.add(r.input_row_index);
  }
  return seen.size;
}

/**
 * 第一个未完成的 input 行索引（0-based）
 */
export function getNextRowIndex(results, totalRows) {
  if (!Array.isArray(results) || results.length === 0) return 0;
  const done = new Set(
    results
      .map((x) => (typeof x.input_row_index === 'number' && x.input_row_index >= 0 ? x.input_row_index : -1))
      .filter((i) => i >= 0)
  );
  let i = 0;
  while (i < totalRows && done.has(i)) i++;
  return i;
}

/**
 * Resume 合并：已有结果 + 新批次
 */
export function mergeResumeResults(existing, newResults, startIndex, content) {
  if (!Array.isArray(existing)) existing = [];
  if (!Array.isArray(newResults)) newResults = [];
  const offset = Math.max(0, startIndex | 0);

  const kept = existing.filter((r) => {
    if (typeof r.input_row_index !== 'number' || r.input_row_index < 0) return true;
    return r.input_row_index < offset;
  });

  const newAdjusted = newResults.map((r, i) => ({
    ...r,
    row_index: kept.length + i,
    input_row_index: (typeof r.input_row_index === 'number' ? r.input_row_index : i) + offset,
  }));

  const merged = [...kept, ...newAdjusted];
  const sorted = merged.slice().sort((a, b) => {
    const ai = a.input_row_index ?? 0;
    const bi = b.input_row_index ?? 0;
    if (ai !== bi) return ai - bi;
    return (a.row_index ?? 0) - (b.row_index ?? 0);
  });

  const withInputRow = embedInputRow(sorted, content);
  return withInputRow.map((r, i) => ({ ...r, row_index: i }));
}

/**
 * 判断单条 result 的 output 是否完全为空（仅 null/undefined 或空对象 {}）
 * 保守判断，避免将有内容的行误标为错误
 */
function isEmptyOutput(r) {
  if (r.error) return false;
  const out = r.output;
  if (out == null) return true;
  if (typeof out !== 'object') return false;
  return Object.keys(out).length === 0;
}

/**
 * 将 output 完全为空的 result 标记为 error，与 Score 中会被排除的错误一致
 */
export function markEmptyOutputAsError(results) {
  if (!Array.isArray(results)) return results;
  return results.map((r) => {
    if (!isEmptyOutput(r)) return r;
    return { ...r, output: null, error: r.error || 'Empty output' };
  });
}

/**
 * 处理 API 返回结果：embed input_row
 */
export function processApiResults(results, content) {
  return embedInputRow(results || [], content);
}

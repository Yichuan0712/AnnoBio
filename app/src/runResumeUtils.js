/**
 * Run / Resume 工具函数（完全重写）
 *
 * 核心原则：每条 result 自包含 input_row，不依赖外部查找。
 * 确保 input_row_index 始终 0-based，保证 Input # 显示 1, 2, 3...
 */

/**
 * 若后端返回 1-based（1,2,3...），转为 0-based（0,1,2...）
 */
function ensureZeroBased(results) {
  if (!Array.isArray(results) || results.length === 0) return results;
  const valid = results.filter((r) => typeof r.input_row_index === 'number' && r.input_row_index >= 0);
  if (valid.length === 0) return results;
  const minIdx = Math.min(...valid.map((r) => r.input_row_index));
  if (minIdx <= 0) return results;
  return results.map((r) => {
    if (typeof r.input_row_index !== 'number' || r.input_row_index < 0) return r;
    return { ...r, input_row_index: Math.max(0, r.input_row_index - minIdx) };
  });
}

/**
 * 给每条 result 嵌入 input_row（输入行数据），保证 result 与 input 一一对应
 * @param {Array} results - 每条需有 input_row_index（0-based）
 * @param {{ headers?: string[], rows?: any[][] }} content
 * @returns {Array}
 */
export function embedInputRow(results, content) {
  if (!Array.isArray(results)) return results;
  const rows = content?.rows;
  if (!Array.isArray(rows)) {
    return results.map((r) => (r.input_row != null ? r : { ...r, input_row: [] }));
  }
  return results.map((r) => {
    const idx = typeof r.input_row_index === 'number' && r.input_row_index >= 0
      ? r.input_row_index
      : -1;
    if (idx < 0) return { ...r, input_row: r.input_row ?? [] };
    const row = rows[idx];
    return { ...r, input_row: Array.isArray(row) ? row.slice() : [] };
  });
}

/**
 * 已完成的不同 input 行数（用于进度条，排除 1 input → 多 output 的影响）
 * @param {Array} results
 * @returns {number}
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
 * 根据 results 中的 input_row_index 推断
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
 * 新批次 input_row_index 为批次内 0,1,2...，需加上 startIndex 得到实际索引
 * 合并后对整批调用 embedInputRow 补全 input_row
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
 * 接收 API 结果后调用：确保 0-based，再 embed input_row
 */
export function processApiResults(results, content) {
  const zeroBased = ensureZeroBased(results || []);
  return embedInputRow(zeroBased, content);
}

/**
 * 接收 poll/merge 结果后调用：确保 0-based（merge 后的结果可能来自不同来源）
 */
export function ensureResultsZeroBased(results) {
  return ensureZeroBased(results || []);
}

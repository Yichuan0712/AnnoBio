/**
 * Observations 压缩（第 1 层 memory 压缩）
 *
 * 背景：在一次 user turn 内部，agent loop 的每一轮都会把整个 `observations`
 * 数组传给 planner，每条 observation 的 `result` 字段包含完整 skill 结果
 * （inspect_node 单条可达 20 KB+）。多轮累积会快速吃掉 LLM 上下文窗口。
 *
 * 这个模块在发给 planner 之前对 observations 做无损语义压缩：
 *   - 规则 A（supersede）：同一 (skillName, normalize(args)) 的旧观察被
 *     最新一次覆盖时，旧观察的 result 替换为占位指针。
 *   - 规则 B（aging）：距末尾超过 keepFullLastN 的观察，即使没被覆盖，
 *     也只保留 summary，result 替换为 aged-out 占位。
 *   - 末尾 keepFullLastN 条无条件保留完整 result。
 *   - 任何分支下都保留 skillName / args / ok / summary，确保 planner
 *     仍能看到执行历史的"骨架"。
 *
 * 注意事项：
 *   - 不修改入参；总是返回新数组（深度只到 result 字段，其它浅拷贝）。
 *   - result 为 null/undefined 的观察不被改写（已经足够小）。
 *   - 占位 result 仍是合法 JSON 对象，后端 json.dumps 不会出错。
 */

const DEFAULT_KEEP_FULL_LAST_N = 3;

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildObservationKey(observation) {
  const skillName = String(observation?.skillName || observation?.skill_name || '').trim();
  const args = observation?.args && typeof observation.args === 'object' && !Array.isArray(observation.args)
    ? observation.args
    : {};
  return `${skillName}::${stableStringify(args)}`;
}

function isObjectResult(result) {
  return result !== null && result !== undefined && typeof result === 'object';
}

/**
 * 把 observations 数组压缩成发给 planner 的版本。
 *
 * @param {Array<object>} observations
 * @param {{ keepFullLastN?: number }} [options]
 * @returns {{
 *   observations: Array<object>,
 *   stats: {
 *     total: number,
 *     keptFull: number,
 *     superseded: number,
 *     agedOut: number,
 *     skipped: number,
 *   },
 * }}
 */
export function compactObservationsForPlanner(observations, options = {}) {
  if (!Array.isArray(observations) || observations.length === 0) {
    return {
      observations: [],
      stats: { total: 0, keptFull: 0, superseded: 0, agedOut: 0, skipped: 0 },
    };
  }

  const keepFullLastN = Number.isFinite(options.keepFullLastN) && options.keepFullLastN > 0
    ? Math.floor(options.keepFullLastN)
    : DEFAULT_KEEP_FULL_LAST_N;

  const total = observations.length;

  // Pass 1：找每个 (skill, args) 最新的 index
  const latestIndexByKey = new Map();
  observations.forEach((observation, index) => {
    if (!observation || typeof observation !== 'object') return;
    const key = buildObservationKey(observation);
    latestIndexByKey.set(key, index);
  });

  let keptFull = 0;
  let superseded = 0;
  let agedOut = 0;
  let skipped = 0;

  // Pass 2：构造压缩后的数组
  const compacted = observations.map((observation, index) => {
    if (!observation || typeof observation !== 'object') {
      skipped += 1;
      return observation;
    }

    // result 已经是空的（null/undefined/非对象），不必再压
    if (!isObjectResult(observation.result)) {
      skipped += 1;
      return observation;
    }

    const key = buildObservationKey(observation);
    const latestIndex = latestIndexByKey.get(key);
    const isLatestForKey = latestIndex === index;
    const isInTailWindow = index >= total - keepFullLastN;

    // 规则 A：被同 key 的更新条覆盖（即使在尾窗口里也压缩，因为有更新数据可看）
    if (!isLatestForKey) {
      superseded += 1;
      return {
        ...observation,
        result: {
          _compacted: 'superseded',
          superseded_by_index: latestIndex + 1, // 1-based 跟 prompt 里 "Observation N" 对齐
          superseded_by_skill: String(observations[latestIndex]?.skillName || observations[latestIndex]?.skill_name || '').trim(),
          note: 'A newer observation supersedes this one; refer to the indicated index for the up-to-date result.',
        },
      };
    }

    // 规则 B：距末尾太远（aging）
    if (!isInTailWindow) {
      agedOut += 1;
      return {
        ...observation,
        result: {
          _compacted: 'aged_out',
          note: 'Result body omitted to save context. The summary above captures the key outcome. If you need the full data, call the inspecting skill again.',
        },
      };
    }

    keptFull += 1;
    return observation;
  });

  return {
    observations: compacted,
    stats: { total, keptFull, superseded, agedOut, skipped },
  };
}

export const __testing__ = {
  stableStringify,
  buildObservationKey,
  DEFAULT_KEEP_FULL_LAST_N,
};

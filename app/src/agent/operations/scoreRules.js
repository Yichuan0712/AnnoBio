import { canonicalizeMatchFlags, DEFAULT_MATCH_FLAGS, SCORE_GT_ROW_INDEX_COLUMN } from '../../scoreMatchPrimitives.js';
import { parseScoreMappingBundle, serializeScoreMappingBundle } from '../../scoreMappingBundle.js';

/** Validate the editor's complete rule tree before its normalizer can discard malformed fields. */
export function validateAgentScoreTree(tree, { inputColumns, outputKeys, gtColumns }) {
  if (!tree || tree.v !== 2 || !tree.input || !tree.output) throw new Error('rule_tree needs {v: 2, input: group, output: group}. Read inspect_node.rules.ruleTree first.');
  let count = 0;
  let rules = 0;
  const ids = new Set();
  function visit(node, side, depth = 0) {
    if (++count > 200 || depth > 12) throw new Error('Evaluate rule_tree exceeds 200 nodes or 12 nesting levels.');
    if (!node || typeof node !== 'object') throw new Error('Every rule_tree node must be a rule or group.');
    if (node.type === 'group') {
      if (!Array.isArray(node.children) || !Array.isArray(node.ops)
        || node.ops.length !== Math.max(0, node.children.length - 1)
        || node.ops.some((op) => !['AND', 'OR'].includes(op))) throw new Error('Each group needs children and exactly one AND/OR op between adjacent children.');
      if (node.groupId !== undefined) {
        if (!Number.isInteger(node.groupId) || node.groupId <= 0 || ids.has(node.groupId)) throw new Error('Group IDs must be unique positive integers.');
        ids.add(node.groupId);
      }
      return { type: 'group', ops: [...node.ops], children: node.children.map((child) => visit(child, side, depth + 1)),
        ...(node.groupId !== undefined ? { groupId: node.groupId } : {}) };
    }
    if (node.type !== 'rule') throw new Error('Every rule_tree node must have type rule or group.');
    const key = String(node.outputKey || '');
    const allowed = side === 'input' ? ['#', '[#]', ...inputColumns.map((column) => `[${column}]`)] : outputKeys;
    if (!allowed.includes(key)) throw new Error(`Unknown ${side} rule field "${key}". Available: ${allowed.join(', ')}.`);
    if (!Array.isArray(node.gtColumns) || !node.gtColumns.length
      || node.gtColumns.some((column) => ![...gtColumns, SCORE_GT_ROW_INDEX_COLUMN].includes(column))) throw new Error(`Rule "${key}" needs existing ground-truth columns.`);
    if (node.matchType !== undefined && node.matchType !== 'exact') throw new Error('Use matchType exact and matchFlags for comparison options.');
    const flags = node.matchFlags || {};
    if (typeof flags !== 'object' || Array.isArray(flags) || Object.keys(flags).some((name) => !(name in DEFAULT_MATCH_FLAGS))) throw new Error('Unknown rule matchFlags; use the flags returned by inspect_node.');
    for (const [name, value] of Object.entries(flags)) {
      if (typeof DEFAULT_MATCH_FLAGS[name] === 'boolean' && typeof value !== 'boolean') throw new Error(`${name} must be boolean.`);
    }
    if (flags.numericMode && !['exact', 'abs', 'rel', 'decimals'].includes(flags.numericMode)) throw new Error('Unknown numericMode.');
    for (const name of ['numericAbsEpsilon', 'numericRelEpsilon']) {
      if (flags[name] !== undefined && (!Number.isFinite(flags[name]) || flags[name] < 0)) throw new Error(`${name} must be a non-negative number.`);
    }
    if (flags.numericDecimalPlaces !== undefined && (!Number.isInteger(flags.numericDecimalPlaces) || flags.numericDecimalPlaces < 0 || flags.numericDecimalPlaces > 20)) throw new Error('numericDecimalPlaces must be an integer from 0 to 20.');
    rules++;
    return { type: 'rule', outputKey: key, gtColumns: [...node.gtColumns], matchType: 'exact', matchFlags: canonicalizeMatchFlags(flags) };
  }
  if (tree.input.type !== 'group' || tree.output.type !== 'group') throw new Error('rule_tree input and output must be groups.');
  const input = visit(tree.input, 'input');
  const output = visit(tree.output, 'output');
  if (!rules) throw new Error('An Evaluate node needs at least one input or comparison rule.');
  const { inputRoot, outputRoot } = parseScoreMappingBundle({ v: 2, input, output });
  return JSON.parse(serializeScoreMappingBundle(inputRoot, outputRoot));
}

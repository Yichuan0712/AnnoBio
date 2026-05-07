/**
 * Pure functions for applying agent-side score-mapping edits.
 *
 * Used by the `update_score_node` skill to surgically modify the rule tree of an
 * agent-created score node. Mirrors the design of `promptNodeEdits.js`:
 *   - op-tagged union of small, atomic operations
 *   - strict locator (each rule located by (outputKey, gtColumns); must match exactly once)
 *   - structured errors with rich diagnostic context
 *
 * Operates on the parsed bundle shape `{ inputRoot, outputRoot }` produced by
 * `parseScoreMappingBundle`. Callers (the runtime) handle JSON parse/serialize
 * and header-context validation.
 */

import { flattenScoreRules } from './scoreRunGtPairing.js';

export const SUPPORTED_SCORE_MAPPING_OPS = Object.freeze([
  'add_rule',
  'remove_rule',
  'modify_rule',
]);

const VALID_TREES = Object.freeze(['input', 'output']);
const VALID_MATCH_TYPES = Object.freeze(['exact', 'abs', 'rel', 'decimals']);
const VALID_NUMERIC_MODES = Object.freeze(['exact', 'abs', 'rel', 'decimals']);

export const DEFAULT_LIMITS = Object.freeze({
  softMaxEdits: 8,
});

const DEFAULT_MATCH_FLAGS = Object.freeze({
  semanticAlign: false,
  embeddingSimilarity: false,
  contains: false,
  ignoreCase: false,
  ignoreSymbols: false,
  ignoreWhitespace: false,
  numericMode: 'exact',
  numericAbsEpsilon: 0,
  numericRelEpsilon: 0,
  numericDecimalPlaces: 2,
});

function buildEditError(detail) {
  const message = String(detail?.message || 'Score mapping edit failed.');
  const error = new Error(message);
  error.name = 'ScoreMappingEditError';
  for (const [key, value] of Object.entries(detail || {})) {
    if (key === 'message') continue;
    try { error[key] = value; } catch (_) { /* ignore */ }
  }
  return error;
}

function normalizeOutputKey(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeGtColumns(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((column) => String(column == null ? '' : column).trim())
    .filter((column) => column !== '');
}

function gtColumnsSignature(gtColumns) {
  return JSON.stringify(normalizeGtColumns(gtColumns).slice().sort());
}

function describeRule(rule) {
  return {
    outputKey: String(rule?.outputKey ?? ''),
    gtColumns: Array.isArray(rule?.gtColumns) ? rule.gtColumns.slice() : [],
  };
}

function emptyGroup() {
  return { type: 'group', ops: [], children: [] };
}

function ensureGroupShape(group) {
  if (!group || group.type !== 'group') return emptyGroup();
  const children = Array.isArray(group.children) ? group.children : [];
  const expectedOpsLen = Math.max(0, children.length - 1);
  let ops = Array.isArray(group.ops) ? group.ops.slice(0, expectedOpsLen) : [];
  while (ops.length < expectedOpsLen) ops.push('AND');
  ops = ops.map((op) => (op === 'OR' ? 'OR' : 'AND'));
  return { ...group, children, ops };
}

function cloneGroup(group) {
  if (!group || group.type !== 'group') return emptyGroup();
  return {
    type: 'group',
    ops: Array.isArray(group.ops) ? group.ops.slice() : [],
    children: Array.isArray(group.children)
      ? group.children.map((child) => (child && child.type === 'group' ? cloneGroup(child) : cloneRule(child)))
      : [],
    ...(typeof group.groupId === 'number' ? { groupId: group.groupId } : {}),
  };
}

function cloneRule(rule) {
  if (!rule || rule.type !== 'rule') return rule;
  return {
    type: 'rule',
    outputKey: String(rule.outputKey ?? ''),
    gtColumns: Array.isArray(rule.gtColumns) ? rule.gtColumns.slice() : [],
    matchType: String(rule.matchType ?? 'exact'),
    matchFlags: rule.matchFlags && typeof rule.matchFlags === 'object'
      ? { ...DEFAULT_MATCH_FLAGS, ...rule.matchFlags }
      : { ...DEFAULT_MATCH_FLAGS },
  };
}

function findRuleLocations(root, outputKey, gtColumns) {
  const targetOutputKey = normalizeOutputKey(outputKey);
  const targetSignature = gtColumnsSignature(gtColumns);
  const locations = [];
  function walk(parent, path) {
    if (!parent || parent.type !== 'group' || !Array.isArray(parent.children)) return;
    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children[i];
      if (!child) continue;
      const childPath = path.concat([i]);
      if (child.type === 'rule') {
        if (
          normalizeOutputKey(child.outputKey) === targetOutputKey
          && gtColumnsSignature(child.gtColumns) === targetSignature
        ) {
          locations.push({ rule: child, parent, indexInParent: i, path: childPath });
        }
      } else if (child.type === 'group') {
        walk(child, childPath);
      }
    }
  }
  walk(root, []);
  return locations;
}

function ruleAlreadyExists(root, outputKey, gtColumns) {
  return findRuleLocations(root, outputKey, gtColumns).length > 0;
}

function describeAvailableRules(root) {
  return flattenScoreRules(root).map((rule) => describeRule(rule));
}

function canonicalizeMatchFlags(input, base = DEFAULT_MATCH_FLAGS) {
  const merged = { ...DEFAULT_MATCH_FLAGS, ...base, ...(input && typeof input === 'object' ? input : {}) };
  const mode = VALID_NUMERIC_MODES.includes(merged.numericMode) ? merged.numericMode : 'exact';
  let absE = Number(merged.numericAbsEpsilon);
  if (!Number.isFinite(absE) || absE < 0) absE = 0;
  let relE = Number(merged.numericRelEpsilon);
  if (!Number.isFinite(relE) || relE < 0) relE = 0;
  let dec = Math.floor(Number(merged.numericDecimalPlaces));
  if (!Number.isFinite(dec)) dec = 2;
  dec = Math.max(0, Math.min(20, dec));
  let embeddingSimilarity = !!merged.embeddingSimilarity;
  let semanticAlign = !!merged.semanticAlign;
  if (embeddingSimilarity && semanticAlign) semanticAlign = false;
  const softString = embeddingSimilarity || semanticAlign;
  return {
    semanticAlign,
    embeddingSimilarity,
    contains: softString ? false : !!merged.contains,
    ignoreCase: softString ? false : !!merged.ignoreCase,
    ignoreSymbols: softString ? false : !!merged.ignoreSymbols,
    ignoreWhitespace: softString ? false : !!merged.ignoreWhitespace,
    numericMode: mode,
    numericAbsEpsilon: absE,
    numericRelEpsilon: relE,
    numericDecimalPlaces: dec,
  };
}

function validateMatchType(value, opIndex, opName) {
  const normalized = String(value || '').trim();
  if (!VALID_MATCH_TYPES.includes(normalized)) {
    throw buildEditError({
      message: `${opName} matchType "${normalized}" is not one of ${VALID_MATCH_TYPES.join(', ')}.`,
      failedOpIndex: opIndex,
      failedOp: opName,
      reason: 'invalid_match_type',
      attempted_match_type: value,
      supported: VALID_MATCH_TYPES.slice(),
    });
  }
  return normalized;
}

function pickTreeRoot(state, tree, opIndex, opName) {
  const normalized = String(tree || '').trim().toLowerCase();
  if (!VALID_TREES.includes(normalized)) {
    throw buildEditError({
      message: `${opName} requires "tree" to be one of ${VALID_TREES.join(', ')}, got "${tree}".`,
      failedOpIndex: opIndex,
      failedOp: opName,
      reason: 'invalid_tree',
      attempted_tree: tree,
    });
  }
  return normalized;
}

function applyAddRule(state, op, opIndex) {
  const tree = pickTreeRoot(state, op?.tree, opIndex, 'add_rule');
  const outputKey = normalizeOutputKey(op?.outputKey);
  if (!outputKey) {
    throw buildEditError({
      message: `add_rule requires a non-empty "outputKey".`,
      failedOpIndex: opIndex,
      failedOp: 'add_rule',
      reason: 'missing_output_key',
    });
  }
  const gtColumns = normalizeGtColumns(op?.gtColumns);
  if (gtColumns.length === 0) {
    throw buildEditError({
      message: `add_rule requires "gtColumns" to be a non-empty array of ground-truth column names.`,
      failedOpIndex: opIndex,
      failedOp: 'add_rule',
      reason: 'missing_gt_columns',
      attempted_output_key: outputKey,
    });
  }
  const matchType = validateMatchType(op?.matchType ?? 'exact', opIndex, 'add_rule');
  const matchFlags = canonicalizeMatchFlags(op?.matchFlags);

  const root = state[tree];
  if (ruleAlreadyExists(root, outputKey, gtColumns)) {
    throw buildEditError({
      message: `add_rule cannot create a rule for outputKey="${outputKey}" with the given gtColumns because an identical rule already exists in the ${tree} tree.`,
      failedOpIndex: opIndex,
      failedOp: 'add_rule',
      reason: 'duplicate_rule',
      attempted_output_key: outputKey,
      attempted_gt_columns: gtColumns,
      tree,
      existing_rules: describeAvailableRules(root),
    });
  }

  const newRule = {
    type: 'rule',
    outputKey,
    gtColumns,
    matchType,
    matchFlags,
  };

  let parentGroup = root;
  let insertIndex = root.children.length;
  if (op?.after && typeof op.after === 'object') {
    const anchorOutputKey = normalizeOutputKey(op.after.outputKey);
    const anchorGtColumns = normalizeGtColumns(op.after.gtColumns);
    const locations = findRuleLocations(root, anchorOutputKey, anchorGtColumns);
    if (locations.length === 0) {
      throw buildEditError({
        message: `add_rule anchor "after" did not match any rule in the ${tree} tree (outputKey="${anchorOutputKey}").`,
        failedOpIndex: opIndex,
        failedOp: 'add_rule',
        reason: 'anchor_not_found',
        attempted_after_output_key: anchorOutputKey,
        attempted_after_gt_columns: anchorGtColumns,
        tree,
        existing_rules: describeAvailableRules(root),
      });
    }
    if (locations.length > 1) {
      throw buildEditError({
        message: `add_rule anchor "after" is ambiguous in the ${tree} tree (matched ${locations.length} rules).`,
        failedOpIndex: opIndex,
        failedOp: 'add_rule',
        reason: 'anchor_ambiguous',
        attempted_after_output_key: anchorOutputKey,
        attempted_after_gt_columns: anchorGtColumns,
        tree,
        match_count: locations.length,
      });
    }
    parentGroup = locations[0].parent;
    insertIndex = locations[0].indexInParent + 1;
  }

  parentGroup.children = [
    ...parentGroup.children.slice(0, insertIndex),
    newRule,
    ...parentGroup.children.slice(insertIndex),
  ];
  const opsInsertIndex = Math.min(insertIndex, parentGroup.ops.length);
  parentGroup.ops = [
    ...parentGroup.ops.slice(0, opsInsertIndex),
    'AND',
    ...parentGroup.ops.slice(opsInsertIndex),
  ];
  parentGroup.ops = parentGroup.ops.slice(0, Math.max(0, parentGroup.children.length - 1));
}

function applyRemoveRule(state, op, opIndex) {
  const tree = pickTreeRoot(state, op?.tree, opIndex, 'remove_rule');
  // Empty outputKey is allowed here so that stray rules (whose outputKey is '')
  // can be cleaned up. Caller must still pass the field explicitly.
  if (!Object.prototype.hasOwnProperty.call(op || {}, 'outputKey')) {
    throw buildEditError({
      message: `remove_rule requires the "outputKey" field (use "" if the target rule has an empty outputKey).`,
      failedOpIndex: opIndex,
      failedOp: 'remove_rule',
      reason: 'missing_output_key',
    });
  }
  const outputKey = normalizeOutputKey(op?.outputKey);
  const gtColumns = normalizeGtColumns(op?.gtColumns);

  const root = state[tree];
  const locations = findRuleLocations(root, outputKey, gtColumns);
  if (locations.length === 0) {
    throw buildEditError({
      message: `remove_rule target was not found in the ${tree} tree (outputKey="${outputKey}").`,
      failedOpIndex: opIndex,
      failedOp: 'remove_rule',
      reason: 'rule_not_found',
      attempted_output_key: outputKey,
      attempted_gt_columns: gtColumns,
      tree,
      existing_rules: describeAvailableRules(root),
    });
  }
  if (locations.length > 1) {
    throw buildEditError({
      message: `remove_rule target is ambiguous in the ${tree} tree (matched ${locations.length} rules with outputKey="${outputKey}"). Refine gtColumns to disambiguate.`,
      failedOpIndex: opIndex,
      failedOp: 'remove_rule',
      reason: 'rule_ambiguous',
      attempted_output_key: outputKey,
      attempted_gt_columns: gtColumns,
      tree,
      match_count: locations.length,
    });
  }

  const { parent, indexInParent } = locations[0];
  parent.children = parent.children.filter((_, i) => i !== indexInParent);
  // Remove the corresponding op slot. Convention: drop ops[indexInParent] when in
  // range, otherwise drop the trailing op so length stays consistent.
  if (parent.ops.length > 0) {
    const opsRemovalIndex = Math.min(indexInParent, parent.ops.length - 1);
    parent.ops = parent.ops.filter((_, i) => i !== opsRemovalIndex);
  }
  parent.ops = parent.ops.slice(0, Math.max(0, parent.children.length - 1));
}

function applyModifyRule(state, op, opIndex) {
  const tree = pickTreeRoot(state, op?.tree, opIndex, 'modify_rule');
  const match = op?.match && typeof op.match === 'object' ? op.match : null;
  if (!match) {
    throw buildEditError({
      message: `modify_rule requires "match: { outputKey, gtColumns }" to identify the target rule.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_rule',
      reason: 'missing_match',
    });
  }
  if (!Object.prototype.hasOwnProperty.call(match, 'outputKey')) {
    throw buildEditError({
      message: `modify_rule.match requires the "outputKey" field (use "" if the target rule has an empty outputKey).`,
      failedOpIndex: opIndex,
      failedOp: 'modify_rule',
      reason: 'missing_match_output_key',
    });
  }
  const matchOutputKey = normalizeOutputKey(match.outputKey);
  const matchGtColumns = normalizeGtColumns(match.gtColumns);

  const set = op?.set && typeof op.set === 'object' && !Array.isArray(op.set) ? op.set : null;
  if (!set) {
    throw buildEditError({
      message: `modify_rule requires a "set" object with at least one of outputKey, gtColumns, matchType, matchFlags.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_rule',
      reason: 'missing_set',
    });
  }

  const root = state[tree];
  const locations = findRuleLocations(root, matchOutputKey, matchGtColumns);
  if (locations.length === 0) {
    throw buildEditError({
      message: `modify_rule target was not found in the ${tree} tree (outputKey="${matchOutputKey}").`,
      failedOpIndex: opIndex,
      failedOp: 'modify_rule',
      reason: 'rule_not_found',
      attempted_match_output_key: matchOutputKey,
      attempted_match_gt_columns: matchGtColumns,
      tree,
      existing_rules: describeAvailableRules(root),
    });
  }
  if (locations.length > 1) {
    throw buildEditError({
      message: `modify_rule target is ambiguous in the ${tree} tree (matched ${locations.length} rules with outputKey="${matchOutputKey}"). Refine match.gtColumns to disambiguate.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_rule',
      reason: 'rule_ambiguous',
      attempted_match_output_key: matchOutputKey,
      attempted_match_gt_columns: matchGtColumns,
      tree,
      match_count: locations.length,
    });
  }

  const target = locations[0].rule;
  const beforeSnapshot = describeRule(target);

  let nextOutputKey = target.outputKey;
  let nextGtColumns = Array.isArray(target.gtColumns) ? target.gtColumns.slice() : [];
  let nextMatchType = String(target.matchType || 'exact');
  let nextMatchFlags = target.matchFlags && typeof target.matchFlags === 'object'
    ? { ...DEFAULT_MATCH_FLAGS, ...target.matchFlags }
    : { ...DEFAULT_MATCH_FLAGS };

  let touched = false;
  if (Object.prototype.hasOwnProperty.call(set, 'outputKey')) {
    const candidate = normalizeOutputKey(set.outputKey);
    if (!candidate) {
      throw buildEditError({
        message: `modify_rule.set.outputKey must be a non-empty string.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_rule',
        reason: 'invalid_set_output_key',
      });
    }
    nextOutputKey = candidate;
    touched = true;
  }
  if (Object.prototype.hasOwnProperty.call(set, 'gtColumns')) {
    const candidate = normalizeGtColumns(set.gtColumns);
    if (candidate.length === 0) {
      throw buildEditError({
        message: `modify_rule.set.gtColumns must be a non-empty array.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_rule',
        reason: 'invalid_set_gt_columns',
      });
    }
    nextGtColumns = candidate;
    touched = true;
  }
  if (Object.prototype.hasOwnProperty.call(set, 'matchType')) {
    nextMatchType = validateMatchType(set.matchType, opIndex, 'modify_rule');
    touched = true;
  }
  if (Object.prototype.hasOwnProperty.call(set, 'matchFlags')) {
    if (!set.matchFlags || typeof set.matchFlags !== 'object' || Array.isArray(set.matchFlags)) {
      throw buildEditError({
        message: `modify_rule.set.matchFlags must be an object.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_rule',
        reason: 'invalid_set_match_flags',
      });
    }
    nextMatchFlags = canonicalizeMatchFlags(set.matchFlags);
    touched = true;
  }
  if (!touched) {
    throw buildEditError({
      message: `modify_rule.set must specify at least one field to change (outputKey, gtColumns, matchType, matchFlags).`,
      failedOpIndex: opIndex,
      failedOp: 'modify_rule',
      reason: 'empty_set',
    });
  }

  // Identity collision check: if outputKey/gtColumns changed, ensure no other rule
  // in the same tree already has the new identity.
  const identityChanged = (
    nextOutputKey !== target.outputKey
    || gtColumnsSignature(nextGtColumns) !== gtColumnsSignature(target.gtColumns)
  );
  if (identityChanged) {
    const collisions = findRuleLocations(root, nextOutputKey, nextGtColumns)
      .filter((loc) => loc.rule !== target);
    if (collisions.length > 0) {
      throw buildEditError({
        message: `modify_rule cannot rename rule to outputKey="${nextOutputKey}" + given gtColumns because another rule in the ${tree} tree already has that identity.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_rule',
        reason: 'identity_collision',
        attempted_new_output_key: nextOutputKey,
        attempted_new_gt_columns: nextGtColumns,
        tree,
        before: beforeSnapshot,
      });
    }
  }

  target.outputKey = nextOutputKey;
  target.gtColumns = nextGtColumns;
  target.matchType = nextMatchType;
  target.matchFlags = nextMatchFlags;
}

const OP_HANDLERS = Object.freeze({
  add_rule: applyAddRule,
  remove_rule: applyRemoveRule,
  modify_rule: applyModifyRule,
});

/**
 * Apply a list of edit ops to a parsed score-mapping bundle.
 *
 * @param {{ inputRoot: object, outputRoot: object }} bundle - parsed bundle (e.g. from parseScoreMappingBundle)
 * @param {Array<object>} edits - list of op-tagged edits
 * @param {{ limits?: object }} [options]
 * @returns {{ state: { inputRoot: object, outputRoot: object }, warnings: string[] }}
 * @throws ScoreMappingEditError on any structural or shape violation
 */
export function applyScoreMappingEdits(bundle, edits, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options?.limits || {}) };
  const state = {
    input: ensureGroupShape(cloneGroup(bundle?.inputRoot || emptyGroup())),
    output: ensureGroupShape(cloneGroup(bundle?.outputRoot || emptyGroup())),
  };
  const warnings = [];

  if (edits == null) {
    return { state: { inputRoot: state.input, outputRoot: state.output }, warnings };
  }
  if (!Array.isArray(edits)) {
    throw buildEditError({
      message: `edits must be an array of op objects.`,
      failedOpIndex: -1,
      failedOp: 'unknown',
      reason: 'edits_not_array',
    });
  }
  if (edits.length === 0) {
    return { state: { inputRoot: state.input, outputRoot: state.output }, warnings };
  }
  if (edits.length > limits.softMaxEdits) {
    warnings.push(
      `edits length ${edits.length} exceeds soft limit ${limits.softMaxEdits}; consider splitting into multiple update_score_node calls so each change is easy to review.`,
    );
  }

  for (let i = 0; i < edits.length; i += 1) {
    const op = edits[i];
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      throw buildEditError({
        message: `edits[${i}] must be an object with an "op" field.`,
        failedOpIndex: i,
        failedOp: 'unknown',
        reason: 'invalid_op_shape',
      });
    }
    const opName = String(op.op || '').trim();
    const handler = OP_HANDLERS[opName];
    if (!handler) {
      throw buildEditError({
        message: `Unknown op "${opName || 'unset'}" at edits[${i}]. Supported ops: ${SUPPORTED_SCORE_MAPPING_OPS.join(', ')}.`,
        failedOpIndex: i,
        failedOp: opName || 'unknown',
        reason: 'unknown_op',
        supported_ops: SUPPORTED_SCORE_MAPPING_OPS.slice(),
      });
    }
    handler(state, op, i, limits);
    state.input = ensureGroupShape(state.input);
    state.output = ensureGroupShape(state.output);
  }

  const remainingRules = [
    ...flattenScoreRules(state.input),
    ...flattenScoreRules(state.output),
  ];
  if (remainingRules.length === 0) {
    throw buildEditError({
      message: `After applying edits, the score mapping has zero rules.`,
      failedOpIndex: -1,
      failedOp: 'final_validation',
      reason: 'no_rules_left',
    });
  }

  return {
    state: { inputRoot: state.input, outputRoot: state.output },
    warnings,
  };
}

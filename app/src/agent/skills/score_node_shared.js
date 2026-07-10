import { emptyScoreRuleGroup, parseScoreMappingBundle } from '../../scoreMappingBundle.js';
import { isScoreInputSideRuleKey, flattenScoreRules } from '../../scoreRunGtPairing.js';
import { findWorkflowNodeById } from './run_node_shared.js';

const SCORE_GT_ROW_INDEX_COLUMN = '__score_gt_row_index__';

function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeNodeId(value, label) {
  const normalized = toCleanString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeActiveMatchMode(value) {
  const normalized = toCleanString(value);
  if (!normalized) return null;
  if (normalized === 'rules' || normalized === 'code') return normalized;
  throw new Error('active_match_mode must be "rules" or "code".');
}

function parseScoreMappingInput(value) {
  if (value == null || value === '') {
    throw new Error('Score mapping is required.');
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const { inputRoot, outputRoot } = parseScoreMappingBundle(raw);
  return {
    v: 2,
    input: inputRoot || emptyScoreRuleGroup(),
    output: outputRoot || emptyScoreRuleGroup(),
  };
}

function extractBracketedInputHeader(outputKey) {
  const raw = toCleanString(outputKey);
  if (raw === '#' || raw === '[#]') return '#';
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).trim();
  }
  return '';
}

function validateScoreMapping(scoreMapping, context = {}) {
  const inputRoot = scoreMapping?.input || emptyScoreRuleGroup();
  const outputRoot = scoreMapping?.output || emptyScoreRuleGroup();
  const inputRules = flattenScoreRules(inputRoot);
  const outputRules = flattenScoreRules(outputRoot);
  const allRules = [...inputRules, ...outputRules];
  if (allRules.length === 0) {
    throw new Error('Score mapping must include at least one rule.');
  }

  const groundTruthHeaders = Array.isArray(context?.groundTruthHeaders)
    ? context.groundTruthHeaders.map((header) => toCleanString(header)).filter(Boolean)
    : [];
  if (groundTruthHeaders.length > 0) {
    const gtHeaderSet = new Set(groundTruthHeaders);
    const unknownGtColumns = [...new Set(
      allRules.flatMap((rule) => (Array.isArray(rule?.gtColumns) ? rule.gtColumns : []))
        .map((column) => toCleanString(column))
        .filter((column) => column && column !== SCORE_GT_ROW_INDEX_COLUMN && !gtHeaderSet.has(column))
    )];
    if (unknownGtColumns.length > 0) {
      throw new Error(`Mapped ground-truth columns were not found: ${unknownGtColumns.join(', ')}.`);
    }
  }

  const runInputHeaders = Array.isArray(context?.runInputHeaders)
    ? context.runInputHeaders.map((header) => toCleanString(header)).filter(Boolean)
    : [];
  if (runInputHeaders.length > 0) {
    const runInputHeaderSet = new Set(runInputHeaders);
    const unknownInputKeys = [...new Set(
      inputRules
        .map((rule) => toCleanString(rule?.outputKey))
        .filter(Boolean)
        .filter((outputKey) => isScoreInputSideRuleKey(outputKey))
        .map((outputKey) => extractBracketedInputHeader(outputKey))
        .filter((header) => header && header !== '#' && !runInputHeaderSet.has(header))
    )];
    if (unknownInputKeys.length > 0) {
      throw new Error(`Mapped run input columns were not found: ${unknownInputKeys.join(', ')}.`);
    }
  }

  return {
    ruleCount: allRules.length,
    inputRuleCount: inputRules.length,
    outputRuleCount: outputRules.length,
  };
}

export function getGroundTruthHeadersFromSnapshot(workflowSnapshot, groundTruthNodeId) {
  const datasetNode = findWorkflowNodeById(workflowSnapshot, groundTruthNodeId);
  if (!datasetNode || String(datasetNode?.type || '').trim() !== 'dataset') {
    throw new Error('Ground-truth dataset node was not found.');
  }
  return Array.isArray(datasetNode?.preview?.headers)
    ? datasetNode.preview.headers.map((header) => toCleanString(header)).filter(Boolean)
    : [];
}

export function getRunInputHeadersFromSnapshot(workflowSnapshot, runNodeId) {
  const runNode = findWorkflowNodeById(workflowSnapshot, runNodeId);
  if (!runNode || String(runNode?.type || '').trim() !== 'run') {
    throw new Error('Run node was not found.');
  }
  const workingSetId = toCleanString(runNode?.config?.runWorkingSetId);
  if (!workingSetId) return [];
  const datasetNode = findWorkflowNodeById(workflowSnapshot, workingSetId);
  if (!datasetNode || String(datasetNode?.type || '').trim() !== 'dataset') return [];
  return Array.isArray(datasetNode?.preview?.headers)
    ? datasetNode.preview.headers.map((header) => toCleanString(header)).filter(Boolean)
    : [];
}

export function buildScoreNodeSpec(args = {}, context = {}) {
  const runNodeId = normalizeNodeId(args?.run_node_id || args?.runNodeId, 'Run node id');
  const groundTruthNodeId = normalizeNodeId(
    args?.ground_truth_node_id || args?.groundTruthNodeId || args?.score_ground_truth_id || args?.scoreGroundTruthId,
    'Ground-truth dataset node id'
  );
  const reviewCredentialId = toCleanString(args?.review_credential_id || args?.reviewCredentialId);
  const name = toCleanString(args?.name) || 'Score';
  const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : null;
  const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : null;
  const matchCode = toCleanString(args?.match_code || args?.matchCode) || null;

  const hasMappingInput = (args?.score_mapping ?? args?.scoreMapping) != null && (args?.score_mapping ?? args?.scoreMapping) !== '';
  let scoreMapping;
  let mappingSummary;
  if (hasMappingInput) {
    scoreMapping = parseScoreMappingInput(args?.score_mapping ?? args?.scoreMapping);
    mappingSummary = validateScoreMapping(scoreMapping, context);
  } else {
    scoreMapping = { v: 2, input: emptyScoreRuleGroup(), output: emptyScoreRuleGroup() };
    mappingSummary = { ruleCount: 0, inputRuleCount: 0, outputRuleCount: 0 };
  }

  if (!matchCode && mappingSummary.ruleCount === 0) {
    throw new Error('Provide either "score_mapping" with at least one rule, or "match_code" for a Match by code score node.');
  }

  const requestedActiveMatchMode = normalizeActiveMatchMode(args?.active_match_mode || args?.activeMatchMode);
  const activeMatchMode = requestedActiveMatchMode || (matchCode ? 'code' : 'rules');

  return {
    runNodeId,
    groundTruthNodeId,
    scoreMapping,
    matchCode,
    activeMatchMode,
    ...(reviewCredentialId ? { reviewCredentialId } : {}),
    name,
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
    ...mappingSummary,
  };
}

export function summarizeScoreNodeSpec(spec = {}) {
  return {
    name: toCleanString(spec?.name) || 'Score',
    runNodeId: toCleanString(spec?.runNodeId || spec?.run_node_id),
    groundTruthNodeId: toCleanString(
      spec?.groundTruthNodeId || spec?.ground_truth_node_id || spec?.scoreGroundTruthId || spec?.score_ground_truth_id
    ),
    reviewCredentialId: toCleanString(spec?.reviewCredentialId || spec?.review_credential_id),
    activeMatchMode: spec?.activeMatchMode === 'code' ? 'code' : 'rules',
    hasMatchCode: Boolean(spec?.matchCode),
    ruleCount: Number(spec?.ruleCount) || 0,
    inputRuleCount: Number(spec?.inputRuleCount) || 0,
    outputRuleCount: Number(spec?.outputRuleCount) || 0,
  };
}

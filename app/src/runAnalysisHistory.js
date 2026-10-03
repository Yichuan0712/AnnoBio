import { datasetSignature, sha256Signature } from './runHistorySignature.js';
import { historyEditFor } from './datasetHistoryEdits.js';

const nodeId = (node) => String(node?.nodeId || node?.id || '');

/**
 * Pick the signature under which an analysis result must be saved before History resolves.
 * Existing nodes keep their previously resolved signature so an input edit cannot attach an old
 * result to the new inputs. A newly created Score or Review has no previous entry yet, so use the
 * signature from the just-resolved canvas; otherwise its first result would be discarded.
 */
export function analysisKeyForSave(priorKeys, currentKeys, kind, id, allowCurrent = true) {
  const previous = priorKeys?.get?.(`${kind}:${id}`);
  if (previous) return previous;
  if (!allowCurrent) return null;
  return currentKeys?.[kind]?.get?.(id) || null;
}

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/** Full Score and Review input keys, independent of their cached output fields. */
export async function analysisInputKeys(state, currentRecordIds) {
  const nodes = new Map((state?.nodes || []).map((node) => [nodeId(node), node]));
  const edges = state?.connections || [];
  const score = new Map();
  const review = new Map();

  async function currentDatasetSignature(id) {
    const dataset = nodes.get(id);
    if (!dataset || dataset.type !== 'dataset') return null;
    const runSourceId = String(dataset.sourceRunNodeId || '');
    const processEdge = !runSourceId && edges.find((edge) => edge.type === 'process-to-dataset' && edge.toId === id);
    const sourceId = runSourceId || processEdge?.fromId;
    if (sourceId) {
      const sourceRecordId = currentRecordIds[sourceId];
      if (!sourceRecordId) return null;
      const branch = runSourceId ? 'result' : String(dataset.processOutputName || 'result');
      return {
        signature: await datasetSignature({
          nodeId: id, sourceRecordId, branch, editedContent: historyEditFor(dataset.historyEdits, sourceRecordId, branch),
        }),
        sourceRecordId,
      };
    }
    const content = dataset.datasetContent || dataset.subsetContent;
    return content ? { signature: await datasetSignature({ nodeId: id, content }) } : null;
  }

  for (const node of nodes.values()) {
    if (node.type !== 'score') continue;
    const id = nodeId(node);
    const runId = edges.find((edge) => edge.type === 'run-to-score' && edge.toId === id)?.fromId;
    const runRecordId = currentRecordIds[runId];
    const groundTruthId = String(node.scoreGroundTruthId || '');
    const groundTruth = groundTruthId ? await currentDatasetSignature(groundTruthId) : null;
    if (!runRecordId || !groundTruth) continue;
    const inputs = {
      runRecordId, groundTruthId, groundTruthSignature: groundTruth.signature,
      mapping: parsed(node.scoreMapping, {}),
      matchCode: String(node.scoreMatchCode || ''),
      activeMatchMode: String(node.scoreActiveMatchMode || 'rules'),
    };
    if (groundTruth.sourceRecordId) inputs.groundTruthSourceRecordId = groundTruth.sourceRecordId;
    score.set(id, { signature: await sha256Signature({ kind: 'score', ...inputs }), inputs });
  }

  async function reviewKey(node, scoreId) {
    const parent = score.get(scoreId);
    const scoreNode = nodes.get(scoreId);
    if (!parent || !scoreNode) return null;
    const inputs = {
      scoreNodeId: scoreId,
      scoreSignature: parent.signature,
      exclusions: parsed(scoreNode.scoreRowExcludedFromScoring, {}),
      reviewMethod: String(scoreNode.reviewMethod || ''),
      reviewCredentialId: String(scoreNode.reviewCredentialId || ''),
      reviewSettings: scoreNode.reviewSettings || {},
      gepaTargetSectionIndex: scoreNode.gepaTargetSectionIndex ?? null,
    };
    return { signature: await sha256Signature({ kind: 'review', ...inputs }), inputs };
  }
  for (const node of nodes.values()) {
    const id = nodeId(node);
    if (node.type === 'score') {
      const key = await reviewKey(node, id);
      if (key) review.set(id, key);
    } else if (node.type === 'promptReview') {
      const scoreId = edges.find((edge) => edge.type === 'score-to-prompt-review' && edge.toId === id)?.fromId;
      const key = await reviewKey(node, scoreId);
      if (key) review.set(id, key);
    }
  }
  return { score, review };
}

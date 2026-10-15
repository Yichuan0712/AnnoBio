import { resolveHistoryCanvasState } from './runHistoryResolver.js';
import { planHistorySelection } from './runHistorySelection.js';
import { captureHistoryInput, runningHistoryRecord } from './runHistoryCapture.js';
import { analysisInputKeys } from './runAnalysisHistory.js';
import { dependentHistoryIds, directHistoryDownstreamIds, directHistoryUpstreamIds } from './runHistoryDeletion.js';
import { describeHistoryRecord } from './runHistoryPresentation.js';
import { contentLocks, recordInputRefs } from './contentLocks.js';

/** Record inputs and origin never change, so these are cached per record ID. */
function recordFacts(record) {
  return { inputRefs: recordInputRefs(record), pipelineRunId: String(record?.pipelineRunId || '') };
}

function relationSummary(record, canvasState, currentIds) {
  const node = (canvasState?.nodes || []).find((item) => String(item?.nodeId || item?.id || '') === String(record.nodeId));
  const nodeName = node?.runName || node?.name || node?.scoreName || node?.promptReviewName || '';
  const promptName = record.kind === 'run' ? String(record.inputs?.prompt?.name || record.summary?.promptName || '') : '';
  const fallback = record.kind === 'score' ? 'Evaluate' : record.kind === 'review' ? 'Optimize' : record.kind ? `${record.kind[0].toUpperCase()}${record.kind.slice(1)}` : 'Record';
  return {
    id: record.id,
    nodeId: record.nodeId,
    kind: record.kind,
    label: [promptName, nodeName || fallback].filter(Boolean).join(' · '),
    createdAt: record.createdAt || '',
    current: currentIds.has(record.id),
  };
}

/** Project-scoped history orchestration. Storage and canvas saving are injected for web/desktop. */
export class RunHistorySession {
  constructor({ loadIndex, loadRecord, saveRecord, deleteRecords, saveCanvas, createId, now }) {
    this.storage = { loadIndex, loadRecord, saveRecord, deleteRecords, saveCanvas };
    this.createId = createId;
    this.now = now;
    this.projectId = null;
    this.index = { version: 1, records: [] };
  }

  /**
   * A canvas without `historyVersion: 1` (a new project, or one saved before History existed) is
   * marked as using History; results cached on its nodes are not turned into records, so a node with
   * no matching record shows no result.
   */
  async open(projectId, state) {
    if (!projectId) throw new Error('Open a project before using history.');
    this.projectId = projectId;
    this.index = await this.storage.loadIndex(projectId);
    let canvas = state;
    if (state?.historyVersion !== 1) {
      canvas = { ...state, historyVersion: 1 };
      await this.storage.saveCanvas(projectId, canvas);
    }
    return this.resolve(canvas);
  }

  async resolve(state) {
    if (!this.projectId) throw new Error('Open a project before using history.');
    return resolveHistoryCanvasState(state, {
      index: this.index,
      loadRecord: (id) => this.storage.loadRecord(this.projectId, id),
    });
  }

  async select(recordId, state, { runningNodeIds = [] } = {}) {
    if (!this.projectId) throw new Error('Open a project before using history.');
    const plan = await planHistorySelection(state, recordId, {
      loadRecord: (id) => this.storage.loadRecord(this.projectId, id),
      recordEntries: this.index.records,
      runningNodeIds,
    });
    const resolved = await this.resolve(plan.state);
    return { ...plan, state: resolved.state, currentRecordIds: resolved.currentRecordIds };
  }

  async putRecord(record) {
    if (!this.projectId) throw new Error('Open a project before using history.');
    await this.storage.saveRecord(this.projectId, record);
    this.facts?.set(record.id, recordFacts(record));
    this.index = await this.storage.loadIndex(this.projectId);
  }

  /** What the session needs from each record beyond its index entry; loaded at most once per record. */
  async recordFacts() {
    this.facts ??= new Map();
    for (const entry of this.index.records) {
      if (!this.facts.has(entry.id)) this.facts.set(entry.id, recordFacts(await this.storage.loadRecord(this.projectId, entry.id)));
    }
    return this.index.records.map((entry) => this.facts.get(entry.id));
  }

  /** Locked Prompt / Dataset / Process nodes (contentLocks.js). */
  async contentLocks(canvasState) {
    if (!this.projectId) return new Map();
    return contentLocks((await this.recordFacts()).map((facts) => facts.inputRefs), canvasState);
  }

  /** Index entries of Run / Process results made on the node itself, not imported from a Pipeline run. */
  async singleNodeRecords() {
    if (!this.projectId) return [];
    const facts = await this.recordFacts();
    return this.index.records.filter((entry, index) => ['run', 'process'].includes(entry.kind) && !facts[index].pipelineRunId);
  }

  async capture(state, nodeId) {
    if (!this.projectId) throw new Error('Open a project before using history.');
    return captureHistoryInput(state, nodeId, {
      index: this.index,
      loadRecord: (id) => this.storage.loadRecord(this.projectId, id),
    });
  }

  /** Reserve an execution record before submitting a backend job. Completed inputs create a new attempt. */
  async reserve(state, nodeId) {
    const capture = await this.capture(state, nodeId);
    const node = (state?.nodes || []).find((item) => String(item?.nodeId || item?.id || '') === String(nodeId));
    const matching = this.index.records.filter((item) => item.nodeId === nodeId && item.signature === capture.signature);
    const preferredId = String(node?.historyRecordId || '');
    const entry = matching.find((item) => item.id === preferredId) || matching.at(-1);
    if (matching.some((item) => item.status === 'running') && entry?.status !== 'running') {
      throw new Error('These inputs already have a running job.');
    }
    if (entry) {
      const existing = await this.storage.loadRecord(this.projectId, entry.id);
      if (!existing || existing.signature !== capture.signature) throw new Error('History record is missing or invalid.');
      if (existing.status === 'running') throw new Error('These inputs already have a running job.');
      if (existing.status === 'completed') {
        const record = runningHistoryRecord(capture, { createId: this.createId, now: this.now });
        await this.putRecord(record);
        return { record, mode: 'rerun' };
      }
      const record = { ...existing, status: 'running', updatedAt: this.now?.() || new Date().toISOString() };
      delete record.backendJobId;
      delete record.error;
      if (capture.kind === 'process') record.results = { dfResults: null };
      await this.putRecord(record);
      return { record, mode: capture.kind === 'run' ? 'resume' : 'restart' };
    }
    const record = runningHistoryRecord(capture, { createId: this.createId, now: this.now });
    await this.putRecord(record);
    return { record, mode: 'new' };
  }

  entriesForNode(nodeId) {
    const order = new Map(this.index.records.map((entry, index) => [entry.id, index]));
    return this.index.records.filter((entry) => entry.nodeId === nodeId)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        || (order.get(b.id) || 0) - (order.get(a.id) || 0));
  }

  async displayEntriesForNode(nodeId, canvasState, { currentRecordIds = {} } = {}) {
    const records = await Promise.all(this.index.records.map((entry) => this.storage.loadRecord(this.projectId, entry.id)));
    for (let index = 0; index < records.length; index += 1) {
      if (!records[index] || records[index].id !== this.index.records[index].id) {
        throw new Error(`History record is missing or invalid: ${this.index.records[index].id}`);
      }
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    const currentIds = new Set(Object.values(currentRecordIds).filter(Boolean));
    const analysis = await analysisInputKeys(canvasState, currentRecordIds);
    for (const [kind, keys] of [['score', analysis.score], ['review', analysis.review]]) {
      for (const [analysisNodeId, key] of keys) {
        const current = [...this.index.records].reverse().find((entry) => entry.kind === kind
          && entry.nodeId === analysisNodeId && entry.signature === key.signature);
        if (current) currentIds.add(current.id);
      }
    }
    return this.entriesForNode(nodeId).map((entry) => {
      const record = byId.get(entry.id);
      if (record.nodeId !== nodeId) throw new Error(`History record is missing or invalid: ${entry.id}`);
      const summarize = (id) => relationSummary(byId.get(id), canvasState, currentIds);
      const byCurrentThenDate = (a, b) => Number(b.current) - Number(a.current)
        || String(b.createdAt).localeCompare(String(a.createdAt));
      const upstream = directHistoryUpstreamIds(records, record.id).map(summarize).sort(byCurrentThenDate);
      const downstream = directHistoryDownstreamIds(records, record.id).map(summarize).sort(byCurrentThenDate);
      return {
        ...entry,
        error: record.error || '',
        relationships: { upstream, downstream },
        display: describeHistoryRecord(record, canvasState),
      };
    });
  }

  async analysisRecord(nodeId, kind, signature) {
    if (!signature) return null;
    const entry = this.index.records.find((item) => item.nodeId === nodeId && item.kind === kind && item.signature === signature);
    return entry ? this.storage.loadRecord(this.projectId, entry.id) : null;
  }

  async saveAnalysis(nodeId, kind, key, results) {
    if (!this.projectId || !['score', 'review'].includes(kind) || !key?.signature) return null;
    const previous = await this.analysisRecord(nodeId, kind, key.signature);
    if (previous && JSON.stringify(previous.results) === JSON.stringify(results)) return previous;
    let inputs = key.inputs || {};
    if (kind === 'review' && !inputs.scoreRecordId) {
      const score = [...this.index.records].reverse().find((entry) => entry.kind === 'score'
        && entry.nodeId === inputs.scoreNodeId && entry.signature === inputs.scoreSignature);
      if (score) inputs = { ...inputs, scoreRecordId: score.id };
    }
    const sourceRecordIds = kind === 'score' ? [inputs.runRecordId].filter(Boolean) : [inputs.scoreRecordId].filter(Boolean);
    const at = this.now?.() || new Date().toISOString();
    const record = previous
      ? { ...previous, inputs, sourceRecordIds, results, updatedAt: at }
      : {
        id: this.createId?.() || globalThis.crypto.randomUUID().replaceAll('-', ''),
        nodeId, kind, signature: key.signature, status: 'completed',
        createdAt: at, updatedAt: at, inputs, sourceRecordIds, results,
      };
    await this.putRecord(record);
    return record;
  }

  async planDelete(recordId, state, { runningNodeIds = [] } = {}) {
    if (!this.projectId) throw new Error('Open a project before using history.');
    const records = await Promise.all(this.index.records.map((entry) => this.storage.loadRecord(this.projectId, entry.id)));
    if (records.some((record) => !record)) throw new Error('A history record is missing.');
    if (!['run', 'process'].includes(records.find((record) => record.id === recordId)?.kind)) {
      throw new Error('Select a Run or Process history record to delete.');
    }
    const ids = dependentHistoryIds(records, recordId);
    const removed = new Set(ids);
    const affected = records.filter((record) => removed.has(record.id));
    if (affected.some((record) => record.status === 'running' || runningNodeIds.includes(record.nodeId))) {
      throw new Error('A dependent history record is running. Stop it before deleting.');
    }
    const resolved = await this.resolve(state);
    if (Object.values(resolved.currentRecordIds).some((id) => removed.has(id))) {
      throw new Error('The current result depends on this record. Select another result before deleting.');
    }
    const analysis = await analysisInputKeys(resolved.state, resolved.currentRecordIds);
    if (affected.some((record) => record.kind === 'score' && analysis.score.get(record.nodeId)?.signature === record.signature
      || record.kind === 'review' && analysis.review.get(record.nodeId)?.signature === record.signature)) {
      throw new Error('The current analysis depends on this record. Select another result before deleting.');
    }
    return { ids, records: affected };
  }

  async delete(recordId, state, options = {}, expectedIds = null) {
    const plan = await this.planDelete(recordId, state, options);
    if (expectedIds && (plan.ids.length !== expectedIds.length || plan.ids.some((id) => !expectedIds.includes(id)))) {
      throw new Error('History changed. Review the deletion again.');
    }
    if (!this.storage.deleteRecords) throw new Error('History deletion is unavailable.');
    await this.storage.deleteRecords(this.projectId, recordId, plan.ids);
    this.index = await this.storage.loadIndex(this.projectId);
    return plan;
  }
}

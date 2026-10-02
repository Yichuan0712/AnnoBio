import { planLegacyHistoryMigration } from './runHistoryMigration.js';
import { resolveHistoryCanvasState } from './runHistoryResolver.js';
import { planHistorySelection } from './runHistorySelection.js';
import { captureHistoryInput, runningHistoryRecord } from './runHistoryCapture.js';
import { analysisInputKeys } from './runAnalysisHistory.js';
import { dependentHistoryIds } from './runHistoryDeletion.js';

function hasLegacyOutput(node) {
  try {
    if (node.type === 'run') {
      const results = typeof node.runResults === 'string' ? JSON.parse(node.runResults) : node.runResults;
      return Array.isArray(results) && results.length > 0;
    }
    if (node.type === 'process') {
      const raw = node.dfResults || node.results;
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return !!result && (Object.keys(result.outputs || {}).length > 0
        || (Array.isArray(result.headers) && Array.isArray(result.rows)));
    }
  } catch (_) {}
  return false;
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

  async open(projectId, state) {
    if (!projectId) throw new Error('Open a project before using history.');
    this.projectId = projectId;
    this.index = await this.storage.loadIndex(projectId);
    let canvas = state;
    let migration = null;
    const initialMigration = state?.historyVersion !== 1;
    const recordedNodeIds = new Set(this.index.records.map((entry) => entry.nodeId));
    const unrecordedResultIds = initialMigration ? null : (state?.nodes || []).filter((node) =>
      !recordedNodeIds.has(node.nodeId) && hasLegacyOutput(node)).map((node) => node.nodeId);
    if (initialMigration || unrecordedResultIds.length) {
      const sourceRecordIds = initialMigration ? {} : (await this.resolve(state)).currentRecordIds;
      migration = await planLegacyHistoryMigration(state, {
        createId: this.createId,
        now: this.now,
        existingEntries: initialMigration ? this.index.records : [],
        onlyNodeIds: unrecordedResultIds,
        sourceRecordIds,
      });
      if (migration.unmigratedNodeIds.length) {
        throw new Error(`Cannot migrate saved results for nodes: ${migration.unmigratedNodeIds.join(', ')}`);
      }
      const existing = new Map(this.index.records.map((entry) => [entry.id, entry]));
      for (const record of migration.records) {
        if (existing.has(record.id)) {
          const stored = await this.storage.loadRecord(projectId, record.id);
          if (stored?.nodeId !== record.nodeId || stored?.kind !== record.kind || stored?.signature !== record.signature) {
            throw new Error(`Legacy history migration conflicts with record ${record.id}.`);
          }
        } else {
          await this.storage.saveRecord(projectId, record);
        }
      }
      this.index = await this.storage.loadIndex(projectId);
      if (initialMigration) {
        const resolved = await this.resolve(migration.state);
        const keys = await analysisInputKeys(resolved.state, resolved.currentRecordIds);
        for (const node of migration.state.nodes || []) {
          const scoreKey = keys.score.get(node.nodeId);
          if (node.type === 'score' && scoreKey && (node.scoreMatchResult || node.scoreRowExcludedFromScoring)) {
            await this.saveAnalysis(node.nodeId, 'score', scoreKey, {
              scoreMatchResult: node.scoreMatchResult || null,
              scoreRowExcludedFromScoring: node.scoreRowExcludedFromScoring || {},
            });
          }
          const reviewKey = keys.review.get(node.nodeId);
          if (reviewKey && (node.reviewResult || node.reviewProgress)) {
            await this.saveAnalysis(node.nodeId, 'review', reviewKey, {
              reviewResult: node.reviewResult || null, reviewProgress: node.reviewProgress || 0,
            });
          }
        }
      }
      await this.storage.saveCanvas(projectId, migration.state);
      canvas = migration.state;
    }
    return { ...(await this.resolve(canvas)), migration };
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
      loadRecord: (id) => this.storage.loadRecord(this.projectId, id), runningNodeIds,
    });
    const resolved = await this.resolve(plan.state);
    return { ...plan, state: resolved.state, currentRecordIds: resolved.currentRecordIds };
  }

  async putRecord(record) {
    if (!this.projectId) throw new Error('Open a project before using history.');
    await this.storage.saveRecord(this.projectId, record);
    this.index = await this.storage.loadIndex(this.projectId);
  }

  async capture(state, nodeId) {
    if (!this.projectId) throw new Error('Open a project before using history.');
    return captureHistoryInput(state, nodeId, {
      index: this.index,
      loadRecord: (id) => this.storage.loadRecord(this.projectId, id),
    });
  }

  /** Reserve a unique input signature before submitting a backend job. */
  async reserve(state, nodeId) {
    const capture = await this.capture(state, nodeId);
    const entry = this.index.records.find((item) => item.nodeId === nodeId && item.signature === capture.signature);
    if (entry) {
      const existing = await this.storage.loadRecord(this.projectId, entry.id);
      if (!existing || existing.signature !== capture.signature) throw new Error('History record is missing or invalid.');
      if (existing.status === 'completed') throw new Error('Run completed for these inputs. Change an input or select History.');
      if (existing.status === 'running') throw new Error('These inputs already have a running job.');
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
    return this.index.records.filter((entry) => entry.nodeId === nodeId)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
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
    const at = this.now?.() || new Date().toISOString();
    const record = previous
      ? { ...previous, results, updatedAt: at }
      : {
        id: this.createId?.() || globalThis.crypto.randomUUID().replaceAll('-', ''),
        nodeId, kind, signature: key.signature, status: 'completed',
        createdAt: at, updatedAt: at, inputs: key.inputs, results,
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

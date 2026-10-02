import { planLegacyHistoryMigration } from './runHistoryMigration.js';
import { resolveHistoryCanvasState } from './runHistoryResolver.js';
import { planHistorySelection } from './runHistorySelection.js';
import { captureHistoryInput, runningHistoryRecord } from './runHistoryCapture.js';

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
  constructor({ loadIndex, loadRecord, saveRecord, saveCanvas, createId, now }) {
    this.storage = { loadIndex, loadRecord, saveRecord, saveCanvas };
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
      await this.storage.saveCanvas(projectId, migration.state);
      canvas = migration.state;
      this.index = await this.storage.loadIndex(projectId);
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
}

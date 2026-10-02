import { planLegacyHistoryMigration } from './runHistoryMigration.js';
import { resolveHistoryCanvasState } from './runHistoryResolver.js';
import { planHistorySelection } from './runHistorySelection.js';

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
    if (state?.historyVersion !== 1) {
      migration = await planLegacyHistoryMigration(state, {
        createId: this.createId,
        now: this.now,
        existingEntries: this.index.records,
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

  entriesForNode(nodeId) {
    return this.index.records.filter((entry) => entry.nodeId === nodeId)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
}

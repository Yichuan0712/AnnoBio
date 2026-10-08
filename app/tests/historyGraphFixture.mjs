/** Shared History test graph: input Dataset → Run → saved Run output → Process → saved Process output.
 * Written in the version 2 fields and upgraded, as a project opened from disk is. */
import { buildRunResultsTable } from '../src/runResultsExport.js';
import { captureHistoryInput, runningHistoryRecord } from '../src/runHistoryCapture.js';
import { upgradeCanvasState } from '../src/canvasFormat.js';

export const content = (value) => ({ headers: ['text'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });
export const prompt = { type: 'prompt', nodeId: 'prompt', name: 'Prompt', sections: [{ content: 'Say {{text}}' }], outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] }, inputTypes: {} };
export const input = { type: 'dataset', nodeId: 'input', name: 'Input', datasetContent: content('hello') };
export const runResults = [{ row_index: 0, input_row_index: 0, output: { answer: 'world' } }];
export const run = { type: 'run', nodeId: 'run', runWorkingSetId: 'input', runInputToColumn: '{"text":"text"}', runInputContent: JSON.stringify(input.datasetContent), runResults: JSON.stringify(runResults), runCompleted: '1' };
const exported = buildRunResultsTable({ results: runResults, runContent: input.datasetContent, schemaFields: prompt.outputFormat.fields });
export const runDataset = { type: 'dataset', nodeId: 'run-dataset', name: 'Run export', sourceRunNodeId: 'run', datasetContent: { ...exported, rowIds: ['generated-id'] } };
export const processResult = { headers: ['answer'], rows: [['processed']] };
export const process = { type: 'process', nodeId: 'process', name: 'Process', dfCode: 'return df', primaryDatasetId: 'run-dataset', dfResults: JSON.stringify({ outputs: { result: processResult }, statusText: '1 branch returned.' }) };
export const processDataset = { type: 'dataset', nodeId: 'process-dataset', name: 'Process export', processOutputName: 'result', datasetContent: { ...processResult, columnTypes: ['text'], rowIds: ['generated-id-2'] } };
export const graph = upgradeCanvasState({
  nodes: [input, prompt, run, runDataset, process, processDataset],
  connections: [
    { type: 'prompt-to-run', fromId: 'prompt', toId: 'run' },
    { type: 'dataset-to-process', fromId: 'run-dataset', toId: 'process' },
    { type: 'process-to-dataset', fromId: 'process', toId: 'process-dataset' },
  ],
});

export const indexOf = (records) => ({ records: records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) });

/**
 * Completed History records for the results cached on the graph's Run and Process, captured the way
 * a real run captures its inputs, so signatures and upstream links match what the app would record.
 * @returns {Promise<{ state: object, records: object[] }>} the graph marked as using History, and its records
 */
export async function recordGraph(state) {
  let next = 0;
  const createId = () => String(++next).padStart(32, '0');
  const now = () => '2026-10-01T00:00:00.000Z';
  const records = [];
  const loadRecord = async (id) => records.find((record) => record.id === id) || null;
  for (const id of ['run', 'process']) {
    const node = state.nodes.find((item) => item.nodeId === id);
    const capture = await captureHistoryInput(state, id, { index: indexOf(records), loadRecord });
    records.push({
      ...runningHistoryRecord(capture, { createId, now }),
      status: 'completed',
      results: node.type === 'run'
        ? { runResults: JSON.parse(node.runResults), runInputContent: JSON.parse(node.runInputContent), runOutputFields: [], runProgress: 100 }
        : { dfResults: JSON.parse(node.dfResults) },
    });
  }
  return { state: { ...structuredClone(state), historyVersion: 1 }, records };
}

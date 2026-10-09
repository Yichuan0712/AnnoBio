/** Shared History test graph: input Dataset → Run → Process, the Process reading the Run's output
 * directly (docs/design/DATA_FLOW_DESIGN.md §3.3). */
import { captureHistoryInput, runningHistoryRecord } from '../src/runHistoryCapture.js';

export const content = (value) => ({ headers: ['text'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });
export const prompt = { type: 'prompt', nodeId: 'prompt', name: 'Prompt', sections: [{ content: 'Say {{text}}' }], outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] }, inputTypes: {} };
export const input = { type: 'dataset', nodeId: 'input', name: 'Input', datasetContent: content('hello') };
export const runResults = [{ row_index: 0, input_row_index: 0, output: { answer: 'world' } }];
export const run = { type: 'run', nodeId: 'run', runInputToColumn: '{"text":"text"}', runInputContent: JSON.stringify(input.datasetContent), runResults: JSON.stringify(runResults), runCompleted: '1' };
export const processResult = { headers: ['answer'], rows: [['processed']] };
export const process = { type: 'process', nodeId: 'process', name: 'Process', dfCode: 'return df', dfResults: JSON.stringify({ outputs: { result: processResult }, statusText: '1 branch returned.' }) };
export const graph = {
  version: 3,
  nodes: [input, prompt, run, process],
  connections: [
    { type: 'prompt-to-run', fromId: 'prompt', toId: 'run' },
    { type: 'data', fromId: 'input', fromPort: 'result', toId: 'run' },
    { type: 'data', fromId: 'run', fromPort: 'result', toId: 'process', alias: 'df' },
  ],
};

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

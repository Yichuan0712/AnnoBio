/** A version 2 canvas covering the input shapes the version 3 upgrade must preserve (canvasFormat.test.mjs). */
const table = (value) => ({ headers: ['text'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });

export function legacyCanvas() {
  return {
    version: 2,
    historyVersion: 1,
    nodes: [
      { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: table('raw') },
      { type: 'dataset', nodeId: 'lookup', name: 'Lookup', datasetContent: table('lookup') },
      { type: 'dataset', nodeId: 'notes', name: 'Lookup', datasetContent: table('notes') },
      { type: 'prompt', nodeId: 'prompt', name: 'Prompt', text: 'Say {{text}}', outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] }, inputTypes: {} },
      { type: 'run', nodeId: 'run', runWorkingSetId: 'raw', runInputToColumn: '{"text":"text"}' },
      // A recorded primary plus an input saved under an alias its name would not give.
      { type: 'process', nodeId: 'saved', dfCode: 'def process(df, df_lookup_table):\n    return df\n', primaryDatasetId: 'raw', datasetAliases: JSON.stringify({ raw: 'df', lookup: 'df_lookup_table' }) },
      // No recorded primary, one connected input, and a Dataset the code names without an edge.
      { type: 'process', nodeId: 'implicit', dfCode: 'def process(df):\n    return df.merge(df_lookup)\n' },
      // A saved alias equal to the alias another Dataset's name gives.
      { type: 'process', nodeId: 'clash', dfCode: 'def process(df, df_lookup):\n    return df\n', primaryDatasetId: 'raw', datasetAliases: JSON.stringify({ notes: 'df_lookup' }) },
    ],
    connections: [
      { fromId: 'prompt', toId: 'run', type: 'prompt-to-run' },
      { fromId: 'raw', toId: 'saved', type: 'dataset-to-process' },
      { fromId: 'lookup', toId: 'saved', type: 'dataset-to-process' },
      { fromId: 'raw', toId: 'implicit', type: 'dataset-to-process' },
      { fromId: 'raw', toId: 'clash', type: 'dataset-to-process' },
      { fromId: 'notes', toId: 'clash', type: 'dataset-to-process' },
    ],
  };
}

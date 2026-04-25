export const createSyntheticDatasetNodeMeta = Object.freeze({
  name: 'create_synthetic_dataset_node',
  description: 'Create a small synthetic dataset node on the workflow canvas from a validated tabular dataset specification.',
  input_schema: {
    name: 'string (required dataset node name)',
    notes: 'string (optional dataset description; synthetic/mock intent is recommended)',
    headers: ['string (required column names)'],
    rows: [
      ['string (required row values, same length as headers)'],
    ],
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});

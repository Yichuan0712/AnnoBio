export const designSyntheticDatasetMeta = Object.freeze({
  name: 'design_synthetic_dataset',
  description: 'Validate and normalize a small synthetic tabular dataset draft before creating it on the canvas.',
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

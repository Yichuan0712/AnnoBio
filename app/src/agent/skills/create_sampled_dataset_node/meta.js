export const createSampledDatasetNodeMeta = Object.freeze({
  name: 'create_sampled_dataset_node',
  description: 'Create a new dataset node by materializing an existing sampler node on the workflow canvas.',
  input_schema: {
    sampler_node_id: 'string (required exact sampler node id)',
    name: 'string (optional sampled dataset node name; defaults to sampler-based generated name)',
    notes: 'string (optional sampled dataset description; defaults to sampler summary)',
    max_sample_uses: 'integer (optional agent-side safety cap for this request when repeatedly sampling the same sampler; defaults to 1)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});

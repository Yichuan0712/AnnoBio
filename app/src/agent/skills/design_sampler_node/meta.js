export const designSamplerNodeMeta = Object.freeze({
  name: 'design_sampler_node',
  description: 'Validate and normalize a sampler-node draft for an existing dataset node before creating it on the canvas.',
  input_schema: {
    source_node_id: 'string (required exact dataset node id to sample from)',
    name: 'string (optional sampler node name)',
    sampling_type: 'string (optional: "with-replacement", "without-replacement", or "specify-rows")',
    sample_size_type: 'string (optional when not specify-rows: "rows" or "ratio"; defaults to "ratio")',
    sample_size: 'integer (optional when not specify-rows; defaults to 100)',
    row_spec: 'string (required when sampling_type is "specify-rows"; e.g. "1 3 5-10")',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});

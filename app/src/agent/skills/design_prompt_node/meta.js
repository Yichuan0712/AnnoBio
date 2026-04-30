export const designPromptNodeMeta = Object.freeze({
  name: 'design_prompt_node',
  description: 'Validate and normalize a complete prompt-node draft before creating it on the canvas. Include realistic output-field examples when possible.',
  input_schema: {
    name: 'string (required prompt node name)',
    note: 'string (required prompt description shown on the node)',
    sections: [
      {
        name: 'string (required section title)',
        content: 'string (required section content)',
      },
    ],
    outputFormat: {
      returnShape: 'string (optional, usually "single" or "table")',
      fields: [
        {
          key: 'string (required output field key)',
          type: 'string (optional field type, defaults to "str")',
          description: 'string (optional field description)',
          examples: ['string (optional example values for this output field; prefer 1-3 realistic examples)'],
          allowNone: 'boolean (optional)',
        },
      ],
    },
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});

export const createPromptNodeMeta = Object.freeze({
  name: 'create_prompt_node',
  description: 'Create a complete prompt node on the workflow canvas from a validated prompt specification. Include realistic output-field examples when possible.',
  input_schema: {
    name: 'string (required prompt node name)',
    note: 'string (required prompt description shown on the node)',
    sections: [
      {
        name: 'string (required section title)',
        content: 'string (required section content)',
      },
    ],
    input_types: 'object (optional placeholder name -> "text", "image" or "pdf")',
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

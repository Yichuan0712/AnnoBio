export const addPromptVersionMeta = Object.freeze({
  name: 'add_prompt_version',
  description: 'Create a new prompt version from an existing prompt node and connect the old prompt to the new one with a prompt-version arrow. By default it duplicates the current prompt for further editing, but it can also apply provided prompt changes while preserving the roadmap connection.',
  input_schema: {
    prompt_node_id: 'string (required exact prompt node id)',
    name: 'string (optional new prompt name; defaults to a unique versioned name based on the source prompt)',
    note: 'string (optional new prompt description; defaults to the source prompt description)',
    sections: [
      {
        name: 'string (required section title when overriding sections)',
        content: 'string (required section content when overriding sections)',
      },
    ],
    outputFormat: {
      returnShape: 'string (optional, usually "single" or "table")',
      fields: [
        {
          key: 'string (required output field key when overriding output format)',
          type: 'string (optional field type, defaults to "str")',
          description: 'string (optional field description)',
          examples: ['string (optional example values)'],
          allowNone: 'boolean (optional)',
        },
      ],
    },
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});

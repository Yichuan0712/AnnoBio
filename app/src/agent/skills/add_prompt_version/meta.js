export const addPromptVersionMeta = Object.freeze({
  name: 'add_prompt_version',
  description: [
    'Derive a new prompt version from an existing prompt node and connect them with a version arrow (source -> new). The chain can be extended any number of times; each follow-up takes the latest prompt as its source.',
    'Use this for INCREMENTAL, SURGICAL refinements that should remain visibly continuous with the source prompt.',
    'You MUST express changes as a list of small `edits` ops; you cannot replace whole sections or rewrite the prompt wholesale.',
    'For a from-scratch rewrite where most wording would change, call `create_prompt_node` instead.',
    'Constraints (enforced; violations return a structured error so you can self-correct):',
    '  - Per replacement: old_text <= 300 chars, new_text <= 600 chars and <= 3x old_text length.',
    '  - Per modify_section: cumulative change ratio <= max(40%, ~80 absolute chars).',
    '  - Globally: total v_source -> v_new content change ratio <= 35%.',
    '  - add_section content <= 1000 chars.',
    'Text matching for replace operations is strict (literal -> trimmed literal -> whitespace-flexible regex). No fuzzy matching. Each old_text must match exactly once inside the target section; if it matches 0 or 2+ times you will get an error and must extend old_text with surrounding context until it is unique.',
  ].join('\n'),
  input_schema: {
    prompt_node_id: 'string (required exact prompt node id of the source prompt; the new version is derived from this prompt and an arrow source -> new is drawn. Always pass the latest prompt in the chain, not an older one.)',
    name: 'string (optional new prompt name; defaults to a unique versioned name based on the source prompt)',
    note: 'string (optional new prompt description; defaults to the source prompt description)',
    edits: [
      {
        op: 'string (required: one of add_section | delete_section | modify_section | add_output_field | remove_output_field | modify_output_field)',
        // Section ops
        name: 'string (add_section: new section title; delete_section: target section title)',
        content: 'string (add_section: full content for the new section; <= 1000 chars)',
        after: 'string (add_section: optional anchor section name; the new section is inserted after it; defaults to end of list)',
        section_name: 'string (modify_section: target section title in the source prompt)',
        new_name: 'string (modify_section: optional rename of the section)',
        text_replacements: [
          {
            old_text: 'string (modify_section: verbatim substring of the existing section content; copy from inspect_node so it matches exactly; <= 300 chars; must match exactly once after strict-tier matching)',
            new_text: 'string (modify_section: replacement text; <= 600 chars and <= 3x old_text length)',
          },
        ],
        append_text: 'string (modify_section: optional text appended to the end of the section after a newline)',
        // Output field ops
        field: {
          key: 'string (add_output_field: new field key)',
          type: 'string (add_output_field: optional, defaults to "str")',
          description: 'string (add_output_field: optional)',
          examples: ['string (add_output_field: optional example values)'],
          allowNone: 'boolean (add_output_field: optional)',
        },
        key: 'string (remove_output_field / modify_output_field: target field key)',
        new_key: 'string (modify_output_field: optional rename of the field)',
        patch: {
          type: 'string (modify_output_field: optional new type)',
          description: 'string (modify_output_field: optional new description)',
          examples: ['string (modify_output_field: optional new examples list, replaces the old list)'],
          allowNone: 'boolean (modify_output_field: optional)',
        },
      },
    ],
    left: 'number (optional x position; defaults to just right of the source prompt node)',
    top: 'number (optional y position; defaults to the source prompt node y)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});

/**
 * What Settings → Generate / Optimize say about how the chosen model returns structured output: one of
 * the backend's four modes (backend/llm_structured.py), found by POST /api/credentials/{id}/structured-check
 * or by the first run that used the model. Kept free of the DOM so it can be tested.
 */

const PROMPTED = 'Structured output is not supported, so the model is asked for JSON in the prompt. Replies are checked against the output fields, but expect more rows with errors.';

const MODE_TEXT = {
  json_schema: 'Structured output: the model takes the output fields as a JSON schema.',
  tool: 'Structured output: the model returns the output fields through a tool call.',
  json_object: PROMPTED,
  prompt: PROMPTED,
};

function isPrompted(mode) {
  return mode === 'json_object' || mode === 'prompt';
}

/** The pill beside a model in the Generate and Optimize pickers: [text, kind] or null. */
export function structuredModePill(c) {
  if (c?.structured_check_ok === false) return ['No structured output', 'error'];
  if (c?.structured_check_ok === true && isPrompted(c.structured_mode)) return ['JSON by prompt', 'warning'];
  return null;
}

/**
 * The status line under a Generate or Optimize model picker.
 * @param {object | undefined} c the chosen credential, as GET /api/credentials lists it
 * @param {{ checking?: boolean, checkError?: string }} [options]
 * @returns {{ hidden: boolean, text: string, title: string, state: 'neutral' | 'ok' | 'warning' | 'error', button: string | null }}
 */
export function structuredModeStatus(c, { checking = false, checkError = '' } = {}) {
  if (!c) return { hidden: true, text: '', title: '', state: 'neutral', button: null };
  const title = c.structured_check_detail || '';
  if (checking) {
    return { hidden: false, text: 'Checking how this model returns structured output...', title: '', state: 'neutral', button: null };
  }
  if (checkError) {
    return { hidden: false, text: `Could not check this model: ${checkError}`, title: '', state: 'warning', button: 'Check again' };
  }
  if (c.structured_check_ok === true) {
    const prompted = isPrompted(c.structured_mode);
    return {
      hidden: false,
      text: MODE_TEXT[c.structured_mode] || 'Structured output: checked.',
      title,
      state: prompted ? 'warning' : 'ok',
      button: 'Check again',
    };
  }
  if (c.structured_check_ok === false) {
    return {
      hidden: false,
      text: `This model could not return structured results in any of the four ways tried. ${title}`.trim(),
      title,
      state: 'error',
      button: 'Check again',
    };
  }
  return { hidden: false, text: 'Not checked yet how this model returns structured output.', title: '', state: 'neutral', button: 'Check' };
}

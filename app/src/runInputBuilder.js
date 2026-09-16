import { isImageCell, inputValues } from './datasetContent.js';

// One compiler shared by manual/Agent runs, Review verification and optimization.
export function compileInput(template, values, types = {}) {
  const content = [];
  const attached = new Set();
  const appendText = (text) => {
    if (!text) return;
    const last = content.at(-1);
    if (last?.type === 'text') last.text += text;
    else content.push({ type: 'text', text });
  };
  let end = 0;
  const pattern = /(?<!\{)\{([^{}]+)\}(?!\})/g;
  for (const match of String(template).matchAll(pattern)) {
    appendText(template.slice(end, match.index));
    const key = match[1];
    const value = values[key];
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      appendText(match[0]);
    } else if (isImageCell(value)) {
      if (types[key] === 'text') throw new Error(`Input "${key}" is Text but maps to an Image column. Change its type in Prompt inputs.`);
      if (!value.assetIds.length) throw new Error(`Missing image for "${key}".`);
      appendText(`\n[Images: ${key}]\n`);
      if (!attached.has(key)) value.assetIds.forEach((asset_id, image_index) => {
        content.push({ type: 'image_ref', asset_id, input_name: key, image_index });
      });
      attached.add(key);
    } else {
      if (types[key] === 'image') throw new Error(`Input "${key}" requires an Image column.`);
      appendText(String(value ?? ''));
    }
    end = match.index + match[0].length;
  }
  appendText(template.slice(end));
  return { content: content.length ? content : [{ type: 'text', text: '' }] };
}

export function compileRows(template, headers, rows, mapping, types = {}) {
  return rows.map((row) => {
    try { return compileInput(template, inputValues(headers, row, mapping), types); }
    catch (error) { return { content: [], error: error.message }; }
  });
}

export function compileReviewInputs(template, entries) {
  return entries.map(([, { row }]) => {
    try { return compileInput(template, row.row_input || {}); }
    catch (error) { return { content: [], error: error.message }; }
  });
}

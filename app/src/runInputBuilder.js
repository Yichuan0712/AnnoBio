import { isImageCell, isPdfCell, inputValues } from './datasetContent.js';

const ASSET_KINDS = {
  image: { test: isImageCell, refType: 'image_ref', label: 'Image' },
  pdf: { test: isPdfCell, refType: 'pdf_ref', label: 'PDF' },
};

// One compiler shared by manual/Agent runs, Review verification and optimization. An input's kind is its
// cell's: an image or PDF cell is attached as files, anything else is text.
export function compileInput(template, values) {
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
    const assetKind = Object.values(ASSET_KINDS).find(({ test }) => test(value));
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      appendText(match[0]);
    } else if (assetKind) {
      if (!value.assetIds.length) throw new Error(`Missing ${assetKind.label.toLowerCase()} for "${key}".`);
      appendText(`\n[${assetKind.label}s: ${key}]\n`);
      if (!attached.has(key)) value.assetIds.forEach((asset_id, index) => {
        content.push({ type: assetKind.refType, asset_id, input_name: key, index });
      });
      attached.add(key);
    } else {
      appendText(String(value ?? ''));
    }
    end = match.index + match[0].length;
  }
  appendText(template.slice(end));
  return { content: content.length ? content : [{ type: 'text', text: '' }] };
}

export function compileRows(template, headers, rows, mapping) {
  return rows.map((row) => {
    try { return compileInput(template, inputValues(headers, row, mapping)); }
    catch (error) { return { content: [], error: error.message }; }
  });
}

export function compileReviewInputs(template, entries) {
  return entries.map(([, { row }]) => {
    try { return compileInput(template, row.row_input || {}); }
    catch (error) { return { content: [], error: error.message }; }
  });
}

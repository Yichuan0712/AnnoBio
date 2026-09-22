import { isImageCell, isPdfCell, inputValues } from './datasetContent.js';

const ASSET_KINDS = {
  image: { test: isImageCell, refType: 'image_ref', label: 'Image' },
  pdf: { test: isPdfCell, refType: 'pdf_ref', label: 'PDF' },
};

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
    const assetEntry = Object.entries(ASSET_KINDS).find(([, { test }]) => test(value));
    const [assetKindKey, assetKind] = assetEntry || [];
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      appendText(match[0]);
    } else if (assetKind) {
      if (types[key] === 'text') throw new Error(`Input "${key}" is Text but maps to a ${assetKind.label} column. Change its type in Prompt inputs.`);
      if (types[key] && types[key] !== assetKindKey && types[key] in ASSET_KINDS) throw new Error(`Input "${key}" requires a ${ASSET_KINDS[types[key]].label} column.`);
      if (!value.assetIds.length) throw new Error(`Missing ${assetKind.label.toLowerCase()} for "${key}".`);
      appendText(`\n[${assetKind.label}s: ${key}]\n`);
      if (!attached.has(key)) value.assetIds.forEach((asset_id, index) => {
        content.push({ type: assetKind.refType, asset_id, input_name: key, index });
      });
      attached.add(key);
    } else {
      if (types[key] in ASSET_KINDS) throw new Error(`Input "${key}" requires a ${ASSET_KINDS[types[key]].label} column.`);
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

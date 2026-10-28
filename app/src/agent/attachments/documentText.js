/** Extract document text in memory. Never execute macros, follow external links or write ZIP entries. */
import { Unzip, UnzipInflate } from 'fflate';
import sax from 'sax';
import { fileExtension } from '../../fileTypes.js';

const MAX_XML_BYTES = 20 * 1024 * 1024;
const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const DRAWING = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main']);
const PRESENTATION = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main']);
const ODF_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const ODF_DRAW = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const ODF_TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';

function xmlParts(bytes) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Expected an unencrypted Office/OpenDocument file. Save a copy without a password.');
  const parts = new Map();
  let entries = 0;
  let total = 0;
  const unzip = new Unzip((file) => {
    if (++entries > 5000) throw new Error('The document contains too many archive entries.');
    if (!/\.(?:xml|rels)$/.test(file.name)) return;
    if (parts.has(file.name)) throw new Error('Duplicate document part.');
    if (file.originalSize > MAX_XML_BYTES) throw new Error('Document XML exceeds the 20 MB extraction limit.');
    const chunks = [];
    let size = 0;
    // Reserve the name before extraction, including for empty files.
    parts.set(file.name, null);
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      total += chunk.length;
      size += chunk.length;
      if (total > MAX_XML_BYTES) throw new Error('Document XML exceeds the 20 MB extraction limit.');
      chunks.push(chunk);
      if (final) {
        const data = new Uint8Array(size);
        let offset = 0;
        for (const block of chunks) { data.set(block, offset); offset += block.length; }
        const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
        parts.set(file.name, new TextDecoder(encoding, { fatal: true }).decode(data));
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small compressed chunks also bound each inflater output before the total-size check.
  for (let offset = 0; offset < bytes.length; offset += 4096) unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
  if ([...parts.values()].some((value) => value === null)) throw new Error('Incomplete document archive.');
  return parts;
}

function visitXml(xml, { open, close, text } = {}) {
  if (typeof xml !== 'string') throw new Error('The document is missing a required XML part.');
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  const stack = [];
  parser.onerror = (error) => { throw error; };
  parser.ondoctype = () => { throw new Error('Document XML with a DOCTYPE is not supported.'); };
  parser.onopentag = (tag) => {
    if (stack.length >= 128) throw new Error('Document XML is too deeply nested.');
    stack.push(tag);
    open?.(tag, stack);
  };
  parser.onclosetag = () => { close?.(stack.at(-1), stack); stack.pop(); };
  parser.ontext = parser.oncdata = (value) => text?.(value, stack);
  parser.write(xml).close();
}

function attr(tag, local, uri) {
  return Object.values(tag.attributes).find((item) => item.local === local && (!uri || item.uri === uri))?.value || '';
}

function relationships(parts, part = '') {
  const slash = part.lastIndexOf('/');
  const name = part ? `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels` : '_rels/.rels';
  const list = new Map();
  if (!parts.has(name)) throw new Error('The document is missing its part relationships.');
  visitXml(parts.get(name), { open(tag) {
    if (tag.local !== 'Relationship' || !tag.uri.endsWith('/relationships')) return;
    if (attr(tag, 'TargetMode').toLowerCase() === 'external') return;
    const target = attr(tag, 'Target');
    if (!target || /[\\?#]|^[a-z][a-z\d+.-]*:/i.test(target)) return;
    const path = target.startsWith('/') ? [] : part.slice(0, slash + 1).split('/').filter(Boolean);
    for (const segment of target.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') { if (!path.length) throw new Error('Invalid document part path.'); path.pop(); }
      else path.push(segment);
    }
    list.set(attr(tag, 'Id'), { path: path.join('/'), type: attr(tag, 'Type') });
  } });
  return list;
}

function officeText(xml) {
  const result = [];
  visitXml(xml, {
    open(tag, stack) {
      if (stack.some((parent) => WORD.has(parent.uri) && parent.local === 'del')) return;
      if ((WORD.has(tag.uri) || DRAWING.has(tag.uri)) && ['br', 'cr'].includes(tag.local)) result.push('\n');
      if (WORD.has(tag.uri) && tag.local === 'tab') result.push('\t');
    },
    text(value, stack) {
      const tag = stack.at(-1);
      if (tag?.local === 't' && (WORD.has(tag.uri) || DRAWING.has(tag.uri)) && !stack.some((parent) => WORD.has(parent.uri) && parent.local === 'del')) result.push(value);
    },
    close(tag) {
      if (WORD.has(tag.uri) || DRAWING.has(tag.uri)) {
        if (['p', 'tr'].includes(tag.local)) result.push('\n');
        else if (tag.local === 'tc') result.push('\t');
      }
    },
  });
  return result.join('').trim();
}

function openDocumentText(xml) {
  const result = [];
  visitXml(xml, {
    open(tag) {
      if (tag.uri === ODF_TEXT && tag.local === 's') result.push(' '.repeat(Math.min(1000, Math.max(1, Number(attr(tag, 'c', ODF_TEXT)) || 1))));
      if (tag.uri === ODF_TEXT && tag.local === 'tab') result.push('\t');
      if (tag.uri === ODF_TEXT && tag.local === 'line-break') result.push('\n');
    },
    text(value, stack) {
      if (stack.some((tag) => tag.uri === ODF_TEXT && ['p', 'h'].includes(tag.local)) && !stack.some((tag) => tag.uri === ODF_TEXT && ['tracked-changes', 'note'].includes(tag.local))) result.push(value);
    },
    close(tag) {
      if ((tag.uri === ODF_TEXT && ['p', 'h'].includes(tag.local)) || (tag.uri === ODF_DRAW && tag.local === 'page') || (tag.uri === ODF_TABLE && tag.local === 'table-row')) result.push('\n');
      if (tag.uri === ODF_TABLE && tag.local === 'table-cell') result.push('\t');
    },
  });
  return result.join('').trim();
}

export function extractDocumentText(name, bytes) {
  const parts = xmlParts(bytes);
  const ext = fileExtension(name);
  let text;
  if (['odt', 'ott', 'odp', 'otp'].includes(ext)) text = openDocumentText(parts.get('content.xml'));
  else {
    const main = [...relationships(parts).values()].find((item) => item.type.endsWith('/officeDocument'))?.path;
    if (!main) throw new Error('The document has no main Office part.');
    if (/^(?:doc|dot)/.test(ext)) text = officeText(parts.get(main));
    else {
      const slides = relationships(parts, main);
      const ordered = [];
      visitXml(parts.get(main), { open(tag) {
        if (tag.local !== 'sldId' || !PRESENTATION.has(tag.uri)) return;
        const id = Object.values(tag.attributes).find((item) => item.local === 'id' && item.uri.endsWith('/relationships'))?.value;
        const slide = slides.get(id);
        if (!slide?.type.endsWith('/slide')) throw new Error('A slide relationship is missing or external.');
        ordered.push(slide.path);
      } });
      text = ordered.map((part, index) => `[Slide ${index + 1}]\n${officeText(parts.get(part))}`).join('\n\n');
    }
  }
  return { text, note: 'Extracted document text only. Layout, images, charts, headers/footers, footnotes, embedded files and speaker notes are not included.' };
}

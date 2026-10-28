import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import numbersPayload from 'xlsx/dist/xlsx.zahl.mjs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { TABLE_FILE_EXTENSIONS, TABLE_FILE_ACCEPT, DOCUMENT_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS, tableFileFormat } from '../src/fileTypes.js';
import { attachmentKind, attachmentDialogFilters, attachmentProblem } from '../src/agent/attachments/attachmentTypes.js';
import { parseTableAttachment, readAttachmentWindow } from '../src/agent/attachments/attachmentContent.js';
import { readWorkbook, parseWorkbookSheet } from '../src/datasetFileParsing.js';
import { extractDocumentText } from '../src/agent/attachments/documentText.js';
import { createFolderAccessStore } from '../src/agent/attachments/folderAccess.js';
import { createLocalFolderRuntime } from '../src/agent/attachments/localFolderRuntime.js';

const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relations = (items) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
const relation = (id, type, target, external = false) => `<Relationship Id="${id}" Type="${relNs}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;
const pack = (parts) => zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, typeof text === 'string' ? strToU8(text) : text])));
const wordXml = (text) => `<w:document xmlns:w="${wordNs}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
const wordFile = (xml = wordXml('First &amp; 第二段')) => pack({ '_rels/.rels': relations(relation('main', 'officeDocument', 'custom/body.xml')), 'custom/body.xml': xml, 'word/vbaProject.bin': strToU8('Not XML. Must never be parsed or executed.') });
const slide = (text) => `<p:sld xmlns:p="${presentationNs}" xmlns:a="${drawingNs}"><p:cSld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:cSld></p:sld>`;

test('shared file filters and parser routes cover every advertised table, document and image', () => {
  const filters = attachmentDialogFilters();
  for (const extension of TABLE_FILE_EXTENSIONS) {
    assert.equal(attachmentKind(`test.${extension.toUpperCase()}`), 'table');
    assert.ok(tableFileFormat(`test.${extension}`));
    assert.ok(TABLE_FILE_ACCEPT.split(',').includes(`.${extension}`));
    assert.ok(filters.find((item) => item.name === 'Tables').extensions.includes(extension));
  }
  for (const extension of DOCUMENT_FILE_EXTENSIONS) assert.equal(attachmentKind(`test.${extension}`), 'document');
  for (const extension of IMAGE_FILE_EXTENSIONS) assert.equal(attachmentKind(`test.${extension}`), 'image');
  for (const extension of ['doc', 'ppt', 'heic', 'parquet', 'zip', 'exe']) assert.equal(attachmentKind(`test.${extension}`), '');
  assert.equal(tableFileFormat('arbitrary.xml'), '', 'generic XML remains source text');
  assert.match(attachmentProblem('document', 21 * 1024 * 1024), /20 MB/);
});

function workbookFile(type) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ID', 'Label'], [1, 'AKT1']]), 'Data');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: type, numbers: numbersPayload }));
}

test('real binary, OpenDocument, Numbers and interchange tables share dataset and attachment parsing', () => {
  for (const [ext, type] of Object.entries({ xlsb: 'xlsb', xlt: 'biff8', ods: 'ods', fods: 'fods', numbers: 'numbers', dbf: 'dbf', dif: 'dif', slk: 'sylk', sylk: 'sylk' })) {
    const bytes = workbookFile(type);
    const expected = { headers: ['ID', 'Label'], rows: [['1', 'AKT1']] };
    const wb = readWorkbook(bytes);
    assert.deepEqual(parseWorkbookSheet(wb, wb.SheetNames[0]), expected, ext);
    const { headers, rows, error } = parseTableAttachment(`test.${ext}`, bytes);
    assert.equal(error, undefined, ext);
    assert.deepEqual({ headers, rows }, expected, ext);
  }
  assert.deepEqual(parseTableAttachment('test.TAB', strToU8('ID\tLabel\n1\tAKT1')), { headers: ['ID', 'Label'], rows: [['1', 'AKT1']] });
});

test('Excel and ODF template fixtures use template content types and preserve cell data', () => {
  for (const [ext, type, from, to] of [
    ['xltx', 'xlsx', 'spreadsheetml.sheet.main+xml', 'spreadsheetml.template.main+xml'],
    ['xltm', 'xlsm', 'ms-excel.sheet.macroEnabled.main+xml', 'ms-excel.template.macroEnabled.main+xml'],
    ['ots', 'ods', 'opendocument.spreadsheet', 'opendocument.spreadsheet-template'],
  ]) {
    const files = unzipSync(workbookFile(type));
    let replaced = false;
    for (const key of Object.keys(files)) {
      if (!/\.xml$|^mimetype$/.test(key)) continue;
      const source = strFromU8(files[key]);
      if (source.includes(from)) { files[key] = strToU8(source.replaceAll(from, to)); replaced = true; }
    }
    assert.ok(replaced, ext);
    assert.deepEqual(parseTableAttachment(`template.${ext}`, zipSync(files)).rows, [['1', 'AKT1']], ext);
  }
});

test('Word document variants extract Unicode text, paragraphs and table cells while ignoring deleted text and macros', async () => {
  const xml = `<w:document xmlns:w="${wordNs}"><w:body><w:p><w:r><w:t>A &amp; B 中文</w:t><w:tab/><w:t>tail</w:t></w:r></w:p><w:del><w:r><w:t>removed</w:t></w:r></w:del><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const bytes = wordFile(xml);
  for (const ext of ['docx', 'docm', 'dotx', 'dotm']) {
    const { text } = extractDocumentText(`test.${ext}`, bytes);
    assert.match(text, /^A & B 中文\ttail\n/);
    assert.match(text, /cell/);
    assert.doesNotMatch(text, /removed|executed/);
  }
  const item = { id: 'a1', name: 'test.docx', kind: 'document', path: 'test.docx' };
  const preview = await readAttachmentWindow(item, { max_chars: 5 }, { readBytes: async () => bytes });
  assert.equal(preview.text, 'A & B');
  assert.equal(preview.more_text, true);
  const next = await readAttachmentWindow(item, { offset: 5, max_chars: 12000 }, { readBytes: async () => bytes });
  assert.equal(preview.text + next.text, extractDocumentText(item.name, bytes).text);
  assert.match(preview.note, /Extracted document text only/);
});

test('PowerPoint variants follow slide relationships and displayed order, excluding orphan slides and notes', () => {
  const bytes = pack({
    '_rels/.rels': relations(relation('main', 'officeDocument', 'ppt/presentation.xml')),
    'ppt/presentation.xml': `<p:presentation xmlns:p="${presentationNs}" xmlns:r="${relNs}"><p:sldIdLst><p:sldId id="10" r:id="second"/><p:sldId id="11" r:id="first"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relations(relation('first', 'slide', 'slides/slide1.xml') + relation('second', 'slide', 'slides/slide2.xml')),
    'ppt/slides/slide1.xml': slide('Later'), 'ppt/slides/slide2.xml': slide('First'), 'ppt/slides/slide99.xml': slide('Orphan'), 'ppt/notesSlides/notesSlide1.xml': slide('Speaker notes'),
  });
  for (const ext of ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm']) assert.equal(extractDocumentText(`test.${ext}`, bytes).text, '[Slide 1]\nFirst\n\n[Slide 2]\nLater', ext);
});

test('OpenDocument text and presentation variants preserve text, spans, spaces and line breaks', () => {
  const bytes = pack({ 'content.xml': '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><text:h>Title</text:h><text:p>Hello<text:s text:c="2"/><text:span>世界</text:span><text:line-break/>Next</text:p></office:body></office:document-content>' });
  for (const ext of ['odt', 'ott', 'odp', 'otp']) assert.equal(extractDocumentText(`test.${ext}`, bytes).text, 'Title\nHello  世界\nNext', ext);
});

test('document readers reject broken, encrypted, unsafe or oversized XML and skip binary archive entries', async () => {
  for (const bytes of [strToU8('not a ZIP'), pack({ 'word/document.xml': '<broken>' }), wordFile('<!DOCTYPE root [<!ENTITY secret SYSTEM "file:///secret">]><root>&secret;</root>'), wordFile('<broken>')]) {
    const preview = await readAttachmentWindow({ id: 'a1', name: 'bad.docx', path: 'bad.docx', kind: 'document' }, {}, { readBytes: async () => bytes });
    assert.match(preview.error, /Could not read the document/);
    assert.equal(preview.text, undefined);
  }
  assert.throws(() => extractDocumentText('bad.docx', pack({ 'word/document.xml': 'x'.repeat(20 * 1024 * 1024 + 1) })), /20 MB extraction limit/);
  const forged = pack({ 'word/document.xml': 'x'.repeat(20 * 1024 * 1024 + 1) });
  new DataView(forged.buffer, forged.byteOffset).setUint32(22, 1, true);
  assert.throws(() => extractDocumentText('forged.docx', forged), /20 MB extraction limit/, 'the actual inflated byte count is checked even if the ZIP size field is forged');
  const bytes = wordFile();
  const files = unzipSync(bytes);
  files['word/media/large.bin'] = new Uint8Array(21 * 1024 * 1024);
  assert.equal(extractDocumentText('test.docx', zipSync(files)).text, 'First & 第二段', 'unused binary files are never inflated');
  const external = pack({ '_rels/.rels': relations(relation('main', 'officeDocument', 'https://example.com/document.xml', true)) });
  assert.throws(() => extractDocumentText('external.docx', external), /no main Office part/);
  assert.ok(parseTableAttachment('bad.xlsb', new Uint8Array([0x50, 0x4b, 0, 0])).error, 'corrupt workbook returns a readable error');
});

test('new local file types retain single-file grants, workbook imports and conversation read budgets', async (t) => {
  const parent = path.dirname(fileURLToPath(import.meta.url));
  const directory = await fs.mkdtemp(path.join(parent, '.common-formats-'));
  t.after(async () => { assert.equal(path.dirname(directory), parent); await fs.rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'files');
  await fs.mkdir(root);
  const tablePath = path.join(root, 'data.xlsb');
  const documentPath = path.join(root, 'report.docm');
  await fs.writeFile(tablePath, workbookFile('xlsb'));
  await fs.writeFile(documentPath, wordFile());
  const store = createFolderAccessStore(path.join(directory, 'grants.json'), { home: path.join(directory, 'home') });
  const entries = await store.grant('chat', [tablePath, documentPath]);
  const attachments = entries.map((entry, i) => ({ ...entry, id: `a${i + 1}` }));
  assert.deepEqual(attachments.map((item) => [item.pathType, item.kind]), [['file', 'table'], ['file', 'document']]);
  const runtime = createLocalFolderRuntime({ id: 'chat', messages: [] }, (id) => attachments.find((item) => item.id === id), {
    readAgentPathFile: (...args) => store.read(...args), snapshotAgentImport: (...args) => store.snapshot(...args), useAgentImportSnapshot: (...args) => store.useSnapshot(...args),
  });
  assert.deepEqual((await runtime.readAttachment({ attachment_id: 'a1' })).columns, ['ID', 'Label']);
  assert.equal((await runtime.readAttachment({ attachment_id: 'a2' })).text, 'First & 第二段');
  assert.equal((await runtime.readAttachment({ attachment_id: 'a2', offset: 1 })).files_read, 2);
  assert.deepEqual((await runtime.resolvePathImports({ attachments: ['a1'] })).table.rows, [['1', 'AKT1']]);
  await assert.rejects(runtime.resolvePathImports({ attachments: ['a2'] }), /Import one table/);
  await assert.rejects(store.read('other-chat', attachments[1].grantId), /another conversation/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseDelimitedText, parseWorkbookSheet, readWorkbook } from '../src/datasetFileParsing.js';
import { attachmentKind, attachmentProblem, looksLikeText, normalizeStoredAttachments } from '../src/agent/attachments/attachmentTypes.js';
import { attachmentsMessageText, readAttachmentWindow } from '../src/agent/attachments/attachmentContent.js';
import { toApiMessages } from '../src/agent/agentLoop.js';
import { fitHistory } from '../src/agent/historyBudget.js';
import { AGENT_TOOL_DEFINITIONS, agentToolDefinitions } from '../src/agent/tools/agentTools.js';

const bytesOf = (text) => new TextEncoder().encode(text);

function workbookBytes(sheets) {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
}

/** deps for readAttachmentWindow over in-memory files keyed by path. */
function depsFor(files) {
  return {
    readBytes: async (path) => {
      if (!(path in files)) throw new Error('The file was moved or deleted. Attach it again.');
      return files[path];
    },
    pdfText: async (_bytes, { firstPage, maxPages }) => ({
      pageCount: 5,
      pages: Array.from({ length: Math.min(maxPages, 5 - firstPage + 1) }, (_, i) => ({ page: firstPage + i, text: `Page ${firstPage + i} text` })),
    }),
    imageSize: async () => ({ width: 640, height: 480 }),
  };
}

test('Create Dataset table parsing: quoted CSV, TSV, a BOM and a missing header', () => {
  assert.deepEqual(parseDelimitedText('\uFEFFPMID,Title\n1,"Kinase, A"\n\n2,Plain\n'), {
    headers: ['PMID', 'Title'],
    rows: [['1', 'Kinase, A'], ['2', 'Plain']],
  });
  assert.deepEqual(parseDelimitedText('a\tb\n1\t2', { tsv: true }), { headers: ['a', 'b'], rows: [['1', '2']] });
  assert.deepEqual(parseDelimitedText('\n\n'), { error: 'No columns found in first line.' });
});

test('CSV quoted fields hold escaped quotes, commas and line breaks (RFC 4180)', () => {
  const csv = 'id,quote,note\r\n1,"Say ""hi""","a, b"\r\n2,"line one\nline two",  plain  \r\n3, "spaced quote" ,\n';
  assert.deepEqual(parseDelimitedText(csv), {
    headers: ['id', 'quote', 'note'],
    rows: [
      ['1', 'Say "hi"', 'a, b'],
      ['2', 'line one\nline two', 'plain'],
      ['3', 'spaced quote', ''],
    ],
  });
  // As before: blank and whitespace-only lines are skipped, empty header cells dropped, rows not padded.
  assert.deepEqual(parseDelimitedText('a,,b\n\n   \n1,2\n""\n'), { headers: ['a', 'b'], rows: [['1', '2'], ['']] });
  // An unclosed quote runs to the end of the file rather than failing.
  assert.deepEqual(parseDelimitedText('a,b\n1,"open\n2,3'), { headers: ['a', 'b'], rows: [['1', 'open\n2,3']] });
});

test('Create Dataset table parsing: workbook sheets', () => {
  const workbook = readWorkbook(workbookBytes({ Sites: [['Kinase', 'Site'], ['AKT1', 'S473'], ['MTOR', '']], Empty: [] }));
  assert.deepEqual(parseWorkbookSheet(workbook, 'Sites'), { headers: ['Kinase', 'Site'], rows: [['AKT1', 'S473'], ['MTOR', '']] });
  assert.deepEqual(parseWorkbookSheet(workbook, 'Empty'), { error: 'Sheet is empty.' });
  assert.equal(parseWorkbookSheet(workbook, 'Missing'), null);
});

test('which files can be attached, and how saved attachments are kept', () => {
  assert.equal(attachmentKind('Ground truth.XLSX'), 'table');
  assert.equal(attachmentKind('scan.jpeg'), 'image');
  assert.equal(attachmentKind('paper.pdf'), 'pdf');
  assert.equal(attachmentKind('clean.py'), 'text');
  assert.equal(attachmentKind('notes.md'), 'text');
  assert.equal(attachmentKind('setup.exe'), '');
  for (const name of ['Dockerfile', 'Makefile', 'Snakefile', 'main.nf', 'reads.fastq', 'calls.vcf', 'App.vue', 'lib.rs', 'C:\\repo\\.gitignore']) {
    assert.equal(attachmentKind(name), 'text', name);
  }
  assert.equal(attachmentKind('live.mlx'), '', 'zipped, not text');
  assert.equal(attachmentProblem('', 10), 'This file type cannot be attached.');
  assert.match(attachmentProblem('pdf', 60 * 1024 * 1024), /under 50 MB/);
  assert.equal(attachmentProblem('table', 1000), '');
  assert.equal(looksLikeText(bytesOf('#!/usr/bin/env python\nprint("héllo")\n')), true);
  assert.equal(looksLikeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x10])), false, 'a zip has NUL bytes');
  assert.equal(looksLikeText(new Uint8Array([0x61, 0xff, 0xfe, 0x62])), false, 'not UTF-8');
  assert.equal(looksLikeText(bytesOf('ab€').slice(0, 4)), true, 'a character cut off by the sample is fine');
  assert.deepEqual(normalizeStoredAttachments([{ id: 'a1', name: 'gt.csv', path: 'C:/gt.csv', size: '12', preview: '{}', extra: 1 }, { name: 'no id' }]), [
    { id: 'a1', name: 'gt.csv', path: 'C:/gt.csv', kind: 'table', size: 12, preview: '{}' },
  ]);
});

test('a table attachment is read one window of rows at a time', async () => {
  const csv = ['PMID,Kinase', ...Array.from({ length: 70 }, (_, i) => `${i + 1},K${i + 1}`)].join('\n');
  const deps = depsFor({ 'C:/gt.csv': bytesOf(csv) });
  const attachment = { id: 'a1', name: 'gt.csv', path: 'C:/gt.csv', kind: 'table' };
  const preview = await readAttachmentWindow(attachment, {}, deps);
  assert.equal(preview.total_rows, 70);
  assert.deepEqual(preview.columns, ['PMID', 'Kinase']);
  assert.equal(preview.rows.length, 20);
  assert.deepEqual(preview.rows[0], { row: 1, PMID: '1', Kinase: 'K1' });
  assert.equal(preview.more_rows, true);
  const later = await readAttachmentWindow(attachment, { start_row: 61, max_rows: 500 }, deps);
  assert.deepEqual(later.rows.map((r) => r.row), [61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
  assert.equal(later.more_rows, false);
});

test('a workbook attachment names its sheets and reads the one asked for', async () => {
  const deps = depsFor({ 'C:/gt.xlsx': workbookBytes({ First: [['a'], ['1']], Second: [['b'], ['2'], ['3']] }) });
  const attachment = { id: 'a2', name: 'gt.xlsx', path: 'C:/gt.xlsx', kind: 'table' };
  const preview = await readAttachmentWindow(attachment, {}, deps);
  assert.equal(preview.sheet, 'First');
  assert.deepEqual(preview.sheets, ['First', 'Second']);
  const second = await readAttachmentWindow(attachment, { sheet: 'Second' }, deps);
  assert.equal(second.total_rows, 2);
  assert.match((await readAttachmentWindow(attachment, { sheet: 'Nope' }, deps)).error, /No sheet named "Nope"/);
});

test('text, PDF and image attachments, and a file that is gone', async () => {
  const code = 'def process(df):\n    return df\n'.repeat(400);
  const deps = depsFor({ 'C:/p.py': bytesOf(code), 'C:/paper.pdf': new Uint8Array(8), 'C:/fig.png': new Uint8Array(1234) });
  const text = await readAttachmentWindow({ id: 'a3', name: 'p.py', path: 'C:/p.py', kind: 'text' }, {}, deps);
  assert.equal(text.text.length, 3000);
  assert.equal(text.more_text, true);
  const rest = await readAttachmentWindow({ id: 'a3', name: 'p.py', path: 'C:/p.py', kind: 'text' }, { offset: 12000, max_chars: 99999 }, deps);
  assert.equal(rest.offset, 12000);
  assert.equal(rest.text, code.slice(12000));
  assert.equal(rest.more_text, false);

  const pdf = await readAttachmentWindow({ id: 'a4', name: 'paper.pdf', path: 'C:/paper.pdf', kind: 'pdf' }, {}, deps);
  assert.equal(pdf.page_count, 5);
  assert.deepEqual(pdf.pages.map((p) => p.page), [1, 2, 3]);
  assert.equal(pdf.more_pages, true);
  const lastPages = await readAttachmentWindow({ id: 'a4', name: 'paper.pdf', path: 'C:/paper.pdf', kind: 'pdf' }, { page: 4 }, deps);
  assert.deepEqual(lastPages.pages.map((p) => p.page), [4, 5]);
  assert.equal(lastPages.more_pages, false);

  const image = await readAttachmentWindow({ id: 'a5', name: 'fig.png', path: 'C:/fig.png', kind: 'image' }, {}, deps);
  assert.deepEqual([image.width, image.height, image.size_bytes], [640, 480, 1234]);

  const gone = await readAttachmentWindow({ id: 'a6', name: 'old.csv', path: 'C:/old.csv', kind: 'table' }, {}, deps);
  assert.equal(gone.error, 'The file was moved or deleted. Attach it again.');
});

test('a user message carries its attachment previews to the model', () => {
  const messages = [
    { role: 'user', content: 'What columns does this have?', attachments: [{ id: 'a1', name: 'gt.csv', kind: 'table', preview: '{"attachment":"a1","columns":["PMID"]}' }] },
    { role: 'user', content: '', attachments: [{ id: 'a2', name: 'x.pdf', kind: 'pdf' }] },
  ];
  const [first, second] = toApiMessages(messages);
  assert.match(first.content, /^What columns does this have\?\n\n\[The user attached a file\./);
  assert.match(first.content, /"columns":\["PMID"\]/);
  assert.match(second.content, /^\[The user attached a file\.[^\n]*\]\n\{"attachment":"a2"/);
  assert.equal(attachmentsMessageText([]), '');
});

test('earlier attachment previews are cut to a note before turns are dropped', () => {
  const big = JSON.stringify({ attachment: 'a1', rows: 'x'.repeat(8000) });
  const messages = [
    { role: 'user', content: 'Look at this', attachments: [{ id: 'a1', name: 'gt.csv', kind: 'table', preview: big }] },
    { role: 'assistant', content: 'It has 70 rows.' },
    { role: 'user', content: 'Thanks' },
  ];
  const fitted = fitHistory(messages, 500);
  assert.equal(fitted.length, 3);
  assert.match(fitted[0].attachments[0].preview, /Preview omitted/);
  assert.equal(messages[0].attachments[0].preview, big, 'the stored conversation is unchanged');
});

test('read_attachment is offered only where the chat takes attachments', () => {
  const names = (tools) => tools.map((t) => t.function.name);
  assert.equal(agentToolDefinitions({ projectOpen: true }), AGENT_TOOL_DEFINITIONS);
  assert.ok(names(agentToolDefinitions({ projectOpen: true, attachments: true })).includes('read_attachment'));
  assert.ok(names(agentToolDefinitions({ projectOpen: false, attachments: true })).includes('read_attachment'));
  assert.ok(!names(agentToolDefinitions({ projectOpen: false })).includes('read_attachment'));
});

// ---------- import_attachment (step 4) ----------

const emptyCanvas = () => ({ nodes: [], connections: [] });
const planCtx = (attachments) => ({ extractInputFields: () => [], attachments });

test('import_attachment makes a table attachment a text Dataset', async () => {
  const { planChangeSet } = await import('../src/agent/operations/changeSet.js');
  const entry = { attachments: [{ id: 'a1', name: 'kinase_gt.xlsx', kind: 'table', size: 900 }],
    table: { headers: ['PMID', 'Kinase'], rows: [['1', 'AKT1'], ['2', 'MTOR']], sheet: 'Sheet1', sheets: ['Sheet1'] } };
  const plan = planChangeSet(emptyCanvas(), [{ op: 'import_attachment', ref: '$gt', attachments: ['a1'] }], planCtx(new Map([[0, entry]])));
  const dataset = plan.state.nodes.find((n) => n.nodeId === plan.refs.$gt);
  assert.equal(dataset.name, 'kinase_gt');
  assert.deepEqual(dataset.datasetContent.headers, ['PMID', 'Kinase']);
  assert.deepEqual(dataset.datasetContent.rows, [['1', 'AKT1'], ['2', 'MTOR']]);
  assert.match(plan.items[0].lines[0], /2 rows from kinase_gt\.xlsx \(sheet "Sheet1"\); columns: PMID, Kinase/);
});

test('import_attachment makes a batch of images one row per file, with project assets once stored', async () => {
  const { planChangeSet } = await import('../src/agent/operations/changeSet.js');
  const attachments = [{ id: 'a2', name: 'fig1.png', kind: 'image', size: 2 * 1024 * 1024 }, { id: 'a3', name: 'fig2.png', kind: 'image', size: 1024 * 1024 }];
  const op = { op: 'import_attachment', ref: '$figs', attachments: ['a2', 'a3'], name: 'Figures' };
  const preview = planChangeSet(emptyCanvas(), [op], planCtx(new Map([[0, { attachments }]])));
  assert.deepEqual(preview.items[0].lines, ['2 images, one row each; columns: Filename, Image', 'The files (3.0 MB) are copied into the project when the proposal is applied.']);
  const assets = [{ id: 'img-1', name: 'fig1.png' }, { id: 'img-2', name: 'fig2.png' }];
  const applied = planChangeSet(emptyCanvas(), [op], planCtx(new Map([[0, { attachments, assets }]])));
  const content = applied.state.nodes.find((n) => n.nodeId === applied.refs.$figs).datasetContent;
  assert.deepEqual(content.headers, ['Filename', 'Image']);
  assert.deepEqual(content.columnTypes, ['text', 'image']);
  assert.deepEqual(content.rows[1], ['fig2.png', { kind: 'images', assetIds: ['img-2'], names: ['fig2.png'] }]);
});

test('import_attachment refuses what Create Dataset could not make', async () => {
  const { planChangeSet } = await import('../src/agent/operations/changeSet.js');
  const attachments = [
    { id: 'a1', name: 'gt.csv', kind: 'table' }, { id: 'a2', name: 'gt2.csv', kind: 'table' },
    { id: 'a3', name: 'fig.png', kind: 'image' }, { id: 'a4', name: 'clean.py', kind: 'text' },
  ];
  const attempt = (ids, entry = { attachments }) => () => planChangeSet(emptyCanvas(), [{ op: 'import_attachment', ref: '$d', attachments: ids }], planCtx(new Map([[0, entry]])));
  assert.throws(attempt(['a9']), /No attachment a9/);
  assert.throws(attempt(['a4']), /Text and code attachments cannot be imported/);
  assert.throws(attempt(['a1', 'a3']), /not a mix/);
  assert.throws(attempt(['a1', 'a2']), /one table attachment per operation/);
  assert.throws(attempt(['a1'], { attachments, table: { error: 'No columns found in first line.' } }), /gt\.csv: No columns found/);
  assert.throws(() => planChangeSet(emptyCanvas(), [{ op: 'import_attachment', attachments: ['a1'] }], planCtx(undefined)), /only in the desktop app/);
});

test('applying import_attachment re-reads the table and stores image files into the project', async () => {
  const { applyProposal } = await import('../src/agent/operations/proposals.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({});
  const stored = [];
  let applied = null;
  const attachments = { a1: { id: 'a1', name: 'gt.csv', path: 'C:/gt.csv', kind: 'table', size: 10 }, a2: { id: 'a2', name: 'fig.png', path: 'C:/fig.png', kind: 'image', size: 10 } };
  const workspace = {
    getCanvasState: emptyCanvas,
    extractInputFields: () => [],
    findAttachment: (id) => attachments[id] || null,
    readAttachmentTable: async () => ({ headers: ['PMID'], rows: [['1'], ['2'], ['3']] }),
    storeAttachmentFiles: async (list) => { stored.push(list.map((a) => a.path)); return list.map((a, i) => ({ id: `asset-${i}`, name: a.name })); },
    applyCanvasState: (state) => { applied = state; },
  };
  try {
    const result = await applyProposal({ operations: [
      { op: 'import_attachment', ref: '$gt', attachments: ['a1'] },
      { op: 'import_attachment', ref: '$img', attachments: ['a2'] },
    ] }, workspace);
    assert.equal(result.status, 'applied');
    assert.deepEqual(stored, [['C:/fig.png']], 'only the image is copied into the project');
    const byId = new Map(applied.nodes.map((n) => [n.nodeId, n]));
    assert.equal(byId.get(result.created.$gt.id).datasetContent.rows.length, 3);
    assert.deepEqual(byId.get(result.created.$img.id).datasetContent.rows[0][1].assetIds, ['asset-0']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('only the desktop tool list describes import_attachment', () => {
  const describes = (tools) => {
    const propose = tools.find((t) => t.function.name === 'propose_changes').function;
    return propose.description.includes('- import_attachment:') && propose.parameters.properties.operations.items.properties.op.enum.includes('import_attachment');
  };
  assert.equal(describes(agentToolDefinitions({ projectOpen: true })), false);
  assert.equal(describes(agentToolDefinitions({ projectOpen: true, attachments: true })), true);
});

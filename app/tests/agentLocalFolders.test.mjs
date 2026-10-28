import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';
import { createFolderAccessStore, fileImportance, globMatcher, isTooBroad, listFolder, resolveInside } from '../src/agent/attachments/folderAccess.js';
import { findPathCandidates } from '../src/agent/attachments/pathMentions.js';
import { normalizeStoredAttachments } from '../src/agent/attachments/attachmentTypes.js';
import { parseJsonRecords } from '../src/datasetFileParsing.js';
import { readAttachmentWindow } from '../src/agent/attachments/attachmentContent.js';
import { agentToolDefinitions } from '../src/agent/tools/agentTools.js';
import { findPendingInteraction, resolveFolderAccess, runAgentLoop, toApiMessages } from '../src/agent/agentLoop.js';
import { createLocalFolderRuntime, folderAccessRequestError } from '../src/agent/attachments/localFolderRuntime.js';
import { applyProposal, previewProposal } from '../src/agent/operations/proposals.js';
import { buildWorkspaceSummary } from '../src/agent/context/workspaceSummary.js';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(testRoot, '.local-folders-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), testRoot);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const storePath = path.join(directory, 'grants.json');
  const imported = [];
  const options = { home: path.join(directory, 'home'), importFiles: async (paths, kind) => {
    imported.push({ paths, kind });
    return paths.map((file, index) => ({ id: `asset-${index}`, name: path.basename(file) }));
  } };
  const store = createFolderAccessStore(storePath, options);
  const [grant] = await store.grant('chat-one', [root]);
  return { root, directory, store, grant, storePath, options, imported };
}

test('path mentions preserve quoted spaces, UNC and multiple paths without URLs or dates', () => {
  assert.deepEqual(findPathCandidates('看看 "D:\\My Data\\papers" 和 `C:/repo/main.py`').map((group) => group.candidates), [['D:\\My Data\\papers'], ['C:/repo/main.py']]);
  assert.deepEqual(findPathCandidates('\\\\server\\share\\repo').map((group) => group.candidates[0]), ['\\\\server\\share\\repo']);
  assert.deepEqual(findPathCandidates('D:\\data\\pdfs 下面的 PDF')[0].candidates, ['D:\\data\\pdfs 下面的 PDF', 'D:\\data\\pdfs']);
  assert.equal(findPathCandidates('D:/one C:/two').length, 2);
  assert.equal(findPathCandidates('https://example.com/home/alice 2023/10/27').length, 0);
  assert.deepEqual(findPathCandidates('"/home/alice/My Data"')[0].candidates, ['/home/alice/My Data']);
  assert.equal(findPathCandidates(Array(30).fill('"D:/repo"').join(' ')).length, 20);
  assert.deepEqual(findPathCandidates('D:\\My Data')[0].candidates, ['D:\\My Data']);
  assert.deepEqual(findPathCandidates('/Volumes/data')[0].candidates, ['/Volumes/data']);
});

test('path recognition cannot shorten a missing child to an existing parent', async (t) => {
  const { store, root } = await fixture(t);
  const missing = path.join(root, 'My Data', 'missing');
  const groups = findPathCandidates(`${missing} 下面的文件`);
  assert.ok(groups[0].candidates.every((candidate) => candidate.includes('missing')));
  assert.deepEqual(await store.grant('chat-one', groups), []);
});

test('grants enforce session ownership, file-only scope, restart persistence and permanent revocation', async (t) => {
  const { root, store, grant, storePath, options } = await fixture(t);
  await fs.writeFile(path.join(root, 'README.md'), 'hello');
  await assert.rejects(store.read('chat-two', grant.grantId, 'README.md'), /another conversation/);
  const [file] = await store.grant('chat-one', [path.join(root, 'README.md')]);
  await assert.rejects(store.read('chat-one', file.grantId, 'other.md'), /file grant/);
  assert.equal((await store.read('chat-one', file.grantId)).data.toString(), 'hello');
  const restarted = createFolderAccessStore(storePath, options);
  assert.equal((await restarted.read('chat-one', grant.grantId, 'README.md')).data.toString(), 'hello');
  await restarted.revoke('chat-one', grant.grantId);
  await assert.rejects(restarted.read('chat-one', grant.grantId, 'README.md'), /removed/);
  await assert.rejects(createFolderAccessStore(storePath, options).list('chat-one', grant.grantId), /removed/);
});

test('path containment rejects traversal, absolute paths and escaping junctions', async (t) => {
  const { root, directory, store, grant } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveInside(root, '../outside/secret.txt'), /outside/);
  await assert.rejects(resolveInside(root, path.join(outside, 'secret.txt')), /relative/);
  await assert.rejects(store.read('chat-one', grant.grantId, 'escape/secret.txt'), /outside/);
  assert.ok(!(await store.list('chat-one', grant.grantId, { recursive: true })).entries.some((item) => item.path.startsWith('escape')));
  assert.equal(isTooBroad(path.parse(root).root), true);
  assert.equal(isTooBroad(directory, directory), true);
  if (process.platform === 'win32') {
    await assert.rejects(resolveInside(root, 'README.md:secret'), /streams/);
    assert.equal(isTooBroad('C:\\Windows\\System32'), true);
  }
});

test('a symlinked home directory cannot bypass the broad-root restriction', async (t) => {
  const { directory, root } = await fixture(t);
  const homeAlias = path.join(directory, 'home-alias');
  await fs.symlink(root, homeAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = createFolderAccessStore(path.join(directory, 'alias-grants.json'), { home: homeAlias });
  const results = await store.grant('chat-one', [root]);
  assert.match(results[0].error, /too broad/);
});

test('directory inventory prioritizes README/dependencies/entry points and skips generated folders', async (t) => {
  const { root } = await fixture(t);
  for (const file of ['z.py', 'README.md', 'requirements.txt', 'main.py']) await fs.writeFile(path.join(root, file), 'x');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'x');
  await fs.mkdir(path.join(root, '.private'));
  await fs.writeFile(path.join(root, '.private', 'ignored.txt'), 'x');
  const result = await listFolder(root, { recursive: true, max_entries: 3 });
  assert.deepEqual(result.entries.map((item) => item.path), ['README.md', 'requirements.txt', 'main.py']);
  assert.equal(result.truncated, true);
  assert.equal(result.file_count, 4);
  assert.equal(fileImportance('README.md') < fileImportance('z.py'), true);
  assert.equal(globMatcher('**/*.py').test('main.py'), true);
  assert.equal(globMatcher('src/*.py').test('src/deep/a.py'), false);
  assert.equal(globMatcher('**/main.py').test('notmain.py'), false);
  assert.equal(globMatcher('*a'.repeat(100) + 'b').test('a'.repeat(200)), false);
  assert.ok((await listFolder(root, { recursive: true, include_hidden: true })).entries.some((item) => item.path === 'node_modules/ignored.js'));
});

test('100 distinct content files is a shared persisted limit, not a per-call or per-grant limit', async (t) => {
  const { root, store, grant, storePath, options } = await fixture(t);
  for (let i = 0; i < 101; i += 1) await fs.writeFile(path.join(root, `${String(i).padStart(3, '0')}.txt`), `File ${i}`);
  assert.equal((await store.list('chat-one', grant.grantId)).file_count, 101);
  const batch = await store.batch('chat-one', grant.grantId, { pattern: '**/*.txt', max_files: 30 });
  assert.equal(batch.files.length, 30);
  assert.equal(batch.next_cursor, '30');
  for (let i = 0; i < 100; i += 1) await store.read('chat-one', grant.grantId, `${String(i).padStart(3, '0')}.txt`);
  assert.equal((await store.read('chat-one', grant.grantId, '000.txt')).files_read, 100);
  await assert.rejects(store.read('chat-one', grant.grantId, '100.txt'), /100-file/);
  const [again] = await store.grant('chat-one', [root]);
  await assert.rejects(store.read('chat-one', again.grantId, '100.txt'), /100-file/);
  await assert.rejects(createFolderAccessStore(storePath, options).read('chat-one', again.grantId, '100.txt'), /100-file/);
  await store.revoke('chat-one', grant.grantId);
  await assert.rejects(store.read('chat-one', again.grantId, '100.txt'), /100-file/);
  const last = await store.snapshot('chat-one', again.grantId, { files: ['100.txt'] }).catch((error) => error);
  assert.match(last.message, /Only tables/);
  await fs.writeFile(path.join(root, 'new.jsonl'), '{"x":1}');
  const importPreview = await store.snapshot('chat-one', again.grantId, { files: ['new.jsonl'] });
  assert.equal((await store.useSnapshot('chat-one', importPreview.token)).files.length, 1, 'import still works after exhausting read budget');
});

test('search returns relative lines, narrows files and kills pathological regular expressions', async (t) => {
  const { root, store, grant } = await fixture(t);
  await fs.writeFile(path.join(root, 'README.md'), 'Intro\nOpenAI client\nOPENAI second\n');
  await fs.writeFile(path.join(root, 'main.py'), 'call_openai()\n');
  const result = await store.search('chat-one', grant.grantId, { query: 'openai', pattern: '**/*.md', max_results: 1 });
  assert.deepEqual(result.matches, [{ path: 'README.md', line: 2, text: 'OpenAI client' }]);
  assert.equal(result.truncated, true);
  await assert.rejects(store.search('chat-one', grant.grantId, { query: '[', regex: true }), /Invalid regular/);
  await fs.writeFile(path.join(root, 'bad.txt'), 'a'.repeat(100000) + '!');
  const hung = await store.search('chat-one', grant.grantId, { query: '(a+)+$', regex: true, pattern: 'bad.txt', time_limit_ms: 200 });
  assert.equal(hung.timedOut, true);
  assert.equal(hung.truncated, true);
});

test('folder import snapshots detect added files and changed content before copying assets', async (t) => {
  const { root, store, grant, imported } = await fixture(t);
  await fs.writeFile(path.join(root, 'one.pdf'), '%PDF-one');
  const first = await store.snapshot('chat-one', grant.grantId, { pattern: '**/*.pdf' });
  assert.equal(first.files.length, 1);
  await fs.writeFile(path.join(root, 'two.pdf'), '%PDF-two');
  await assert.rejects(store.useSnapshot('chat-one', first.token, { store: true }), /file list changed/);
  assert.equal(imported.length, 0);
  const second = await store.snapshot('chat-one', grant.grantId, { files: ['one.pdf'] });
  await fs.writeFile(path.join(root, 'one.pdf'), '%PDF-new');
  await assert.rejects(store.useSnapshot('chat-one', second.token, { store: true }), /file changed/);
  const third = await store.snapshot('chat-one', grant.grantId, { files: ['one.pdf'] });
  await assert.rejects(store.useSnapshot('chat-two', third.token, { store: true }), /expired/);
  const result = await store.useSnapshot('chat-one', third.token, { store: true });
  assert.deepEqual(result.assets, [{ id: 'asset-0', name: 'one.pdf' }]);
  await store.revoke('chat-one', grant.grantId);
  await assert.rejects(store.useSnapshot('chat-one', third.token, { store: true }), /expired|removed/);
});

test('JSON and JSONL share column union, ordering, nested values and precise errors', async () => {
  const input = '[{"a":0,"nested":{"ok":true}},{"b":false,"a":null}]';
  assert.deepEqual(parseJsonRecords(input), { headers: ['a', 'nested', 'b'], rows: [['0', '{"ok":true}', ''], ['', '', 'false']] });
  assert.deepEqual(parseJsonRecords('{"data":[{"x":1}]}'), { headers: ['x'], rows: [['1']] });
  assert.match(parseJsonRecords('{"x":1}\n\nbad', { lines: true }).error, /line 3/);
  assert.match(parseJsonRecords('[1]').error, /Record 1/);
  assert.match(parseJsonRecords('{"a":[],"b":[]}').error, /exactly one/);
  const file = { id: 'a1', name: 'package.json', kind: 'table', path: '/config' };
  const deps = { readBytes: async () => new TextEncoder().encode(input) };
  assert.equal((await readAttachmentWindow(file, { format: 'text' }, deps)).text, input);
  assert.deepEqual((await readAttachmentWindow(file, { format: 'table' }, deps)).columns, ['a', 'nested', 'b']);
  const config = '{"name":"demo"}';
  assert.equal((await readAttachmentWindow(file, {}, { readBytes: async () => new TextEncoder().encode(config) })).text, config);
});

test('folder grants and revocation survive attachment normalization, and revoked previews are omitted', () => {
  const items = normalizeStoredAttachments([{ id: 'f1', name: 'repo', kind: 'folder', path: 'C:/repo', grantId: 'grant', revoked: true, preview: 'secret old preview' }]);
  assert.equal(items[0].grantId, 'grant');
  assert.equal(items[0].kind, 'folder');
  assert.equal(items[0].revoked, true);
  const sent = toApiMessages([{ role: 'user', content: 'read', attachments: items }]);
  assert.doesNotMatch(sent[0].content, /secret old preview/);
  assert.match(sent[0].content, /access removed/);
});

test('folder tools are desktop-only, including before a project is opened', () => {
  for (const projectOpen of [true, false]) {
    const web = agentToolDefinitions({ projectOpen }).map((item) => item.function.name);
    const desktop = agentToolDefinitions({ projectOpen, attachments: true }).map((item) => item.function.name);
    for (const name of ['list_folder', 'search_folder', 'read_folder', 'request_folder_access']) {
      assert.equal(web.includes(name), false);
      assert.equal(desktop.includes(name), true);
    }
  }
});

test('folder permission cards wait for Allow and record a revocable tool-result grant', () => {
  const messages = [{ role: 'assistant', toolCalls: [{ id: 't1', name: 'request_folder_access', arguments: '{"path":"C:/repo","reason":"Read project"}', preview: { path: 'C:/repo', items: [] } }] }];
  const pending = findPendingInteraction(messages);
  assert.equal(pending.kind, 'folder');
  resolveFolderAccess(messages, pending, { status: 'allowed', attachment: { id: 'f1', grantId: 'g', kind: 'folder' } });
  assert.equal(findPendingInteraction(messages), null);
  assert.equal(messages[1].attachments[0].grantId, 'g');
});

test('folder import proposal carries the preview snapshot through application', async (t) => {
  const { root, store, grant } = await fixture(t);
  await fs.writeFile(path.join(root, 'rows.jsonl'), '{"id":1}\n{"id":2}');
  const folder = { id: 'f1', grantId: grant.grantId, kind: 'folder' };
  const api = {
    snapshotAgentImport: (...args) => store.snapshot(...args),
    useAgentImportSnapshot: (...args) => store.useSnapshot(...args),
  };
  const runtime = createLocalFolderRuntime({ id: 'chat-one' }, (id) => id === 'f1' ? folder : null, api);
  let applied;
  const workspace = { getCanvasState: () => ({ nodes: [], connections: [] }), extractInputFields: () => [],
    findAttachment: (id) => id === 'f1' ? folder : null, ...runtime,
    applyCanvasState: (state) => { applied = state; } };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({});
  t.after(() => { globalThis.fetch = oldFetch; });
  const proposal = { operations: [{ op: 'import_attachment', folder: 'f1', files: ['rows.jsonl'], ref: '$data' }] };
  const preview = await previewProposal(proposal, workspace);
  assert.equal(preview.ok, true, preview.error);
  assert.ok(preview.importSnapshots[0]);
  await applyProposal(proposal, workspace, { importSnapshots: preview.importSnapshots });
  assert.deepEqual(applied.nodes[0].datasetContent.rows, [['1'], ['2']]);
  await assert.rejects(applyProposal(proposal, workspace), /fresh preview/);
});

test('workspace location includes a permission reminder even for an empty desktop project', async () => {
  assert.match(await buildWorkspaceSummary({ nodes: [] }, { projectPath: 'C:\\projects\\demo.yc' }), /Project file: C:\\projects\\demo.yc \(folder: C:\\projects\)/);
  assert.doesNotMatch(await buildWorkspaceSummary({ nodes: [] }), /Project file/);
});

test('a project over 100 files reads important files first and stops across batch pages', async (t) => {
  const { root, store, grant } = await fixture(t);
  for (let i = 0; i < 105; i += 1) await fs.writeFile(path.join(root, `file-${i}.txt`), 'example');
  await fs.writeFile(path.join(root, 'README.md'), 'Important project overview');
  const api = {
    batchAgentFolder: (...args) => store.batch(...args),
    readAgentPathFile: (...args) => store.read(...args),
  };
  const folder = { id: 'f1', kind: 'folder', grantId: grant.grantId };
  const runtime = createLocalFolderRuntime({ id: 'chat-one' }, () => folder, api);
  const first = await runtime.readFolder({ attachment_id: 'f1', pattern: '**/*' });
  assert.equal(first.files[0].path, 'README.md');
  let count = first.files.length;
  let page = first;
  while (page.next_cursor) {
    page = await runtime.readFolder({ attachment_id: 'f1', pattern: '**/*', cursor: page.next_cursor });
    count += page.files.length;
  }
  assert.equal(count, 100);
  assert.equal(page.total_files, 106);
  assert.match(page.note, /100-file/);
});

test('single file path imports use preview snapshots without spending content budget', async (t) => {
  const { root, store } = await fixture(t);
  const fullPath = path.join(root, 'rows.jsonl');
  await fs.writeFile(fullPath, '{"x":1}');
  const [granted] = await store.grant('chat-one', [fullPath]);
  const item = { ...granted, id: 'a1' };
  const api = { snapshotAgentImport: (...args) => store.snapshot(...args), useAgentImportSnapshot: (...args) => store.useSnapshot(...args) };
  const runtime = createLocalFolderRuntime({ id: 'chat-one' }, (id) => id === 'a1' ? item : null, api);
  const entry = await runtime.resolvePathImports({ attachments: ['a1'] });
  assert.deepEqual(entry.table.rows, [['1']]);
  const applied = await runtime.resolvePathImports({ attachments: ['a1'] }, { token: entry.snapshotToken, store: true });
  assert.deepEqual(applied.table.rows, [['1']]);
  await fs.writeFile(fullPath, '{"x":2}');
  await assert.rejects(runtime.resolvePathImports({ attachments: ['a1'] }, { token: entry.snapshotToken, store: true }), /file changed/);
});

test('the model loop previews folder access without granting it, including before a project exists', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (url) => String(url).includes('/api/agent/context')
    ? Response.json({ context_tokens: 128000, reply_tokens: 8192, system_prompt_tokens: 2000 })
    : new Response(`data: ${JSON.stringify({ type: 'tool_calls', tool_calls: [{ id: 'access', name: 'request_folder_access', arguments: '{"path":"C:/repo","reason":"Inspect source"}' }] })}\n\ndata: {"type":"done","finish_reason":"tool_calls"}\n\n`);
  let checks = 0;
  const messages = [{ role: 'user', content: 'Inspect the project directory' }];
  const result = await runAgentLoop({ messages, credentialId: 'mock', workspaceSummary: 'No project is open.', runtime: {
    projectOpen: false, readAttachment: async () => {},
    previewFolderAccess: async () => { checks += 1; return { ok: true, path: 'C:/repo', items: [] }; },
  } });
  assert.equal(checks, 1);
  assert.equal(result, 'waiting');
  const request = findPendingInteraction(messages);
  assert.equal(request.kind, 'folder');
  assert.equal(request.preview.path, 'C:/repo');
  assert.equal(messages.some((message) => message.attachments?.length), false);
  resolveFolderAccess(messages, request, { status: 'denied' });
  assert.equal(findPendingInteraction(messages), null);
});

test('user-typed paths attached to question answers reach the model as previews', () => {
  const messages = [{ role: 'tool', toolCallId: 'question', name: 'ask_user', content: 'Use this folder', attachments: [{ id: 'f1', kind: 'folder', preview: '{"attachment":"f1","kind":"folder"}' }] }];
  const sent = toApiMessages(messages);
  assert.match(sent[0].content, /"attachment":"f1"/);
  assert.equal(sent[0].role, 'tool');
});

test('a local XLSM file can be granted, previewed and imported without requesting its folder', async (t) => {
  const { root, store } = await fixture(t);
  const fullPath = path.join(root, '0801.xlsm');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['ID', 'Label'], ['1', 'AKT1']]), 'Data');
  await fs.writeFile(fullPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsm' }));
  const [granted] = await store.grant('chat-one', [{ candidates: [fullPath], exact: true }]);
  assert.equal(granted.kind, 'table');
  assert.equal(granted.pathType, 'file');
  const item = { ...granted, id: 'a1' };
  const runtime = createLocalFolderRuntime({ id: 'chat-one', messages: [{ role: 'user', attachments: [item] }] }, (id) => id === 'a1' ? item : null, {
    readAgentPathFile: (...args) => store.read(...args),
    snapshotAgentImport: (...args) => store.snapshot(...args),
    useAgentImportSnapshot: (...args) => store.useSnapshot(...args),
    checkAgentFolder: () => { throw new Error('Must not request folder access'); },
  });
  const preview = await runtime.readAttachment({ attachment_id: 'a1' });
  assert.equal(preview.sheet, 'Data');
  assert.deepEqual(preview.columns, ['ID', 'Label']);
  const imported = await runtime.resolvePathImports({ attachments: ['a1'] });
  assert.deepEqual(imported.table.rows, [['1', 'AKT1']]);
  await assert.rejects(runtime.readAttachment({ attachment_id: fullPath }), /attachment id from a preview/);
});

test('unsupported paths retain file metadata instead of becoming folder attachments', async (t) => {
  const { root, store } = await fixture(t);
  const fullPath = path.join(root, 'unsupported.bin');
  await fs.writeFile(fullPath, Buffer.from([0, 1, 2, 0]));
  const [failed] = await store.grant('chat-one', [fullPath]);
  assert.equal(failed.kind, 'unsupported');
  assert.equal(failed.pathType, 'file');
  assert.equal(failed.name, 'unsupported.bin');
  assert.equal(failed.grantId, undefined);
  assert.equal(normalizeStoredAttachments([{ ...failed, id: 'a1' }])[0].pathType, 'file');
});

test('file errors cannot produce broader folder cards or grant from old pending cards', async (t) => {
  const { root, store } = await fixture(t);
  const fullPath = path.join(root, '0801.xlsm');
  let grants = 0;
  const conversation = { id: 'chat-one', messages: [{ role: 'user', attachments: [
    { id: 'f1', name: fullPath, path: fullPath, kind: 'folder', error: 'This file type cannot be attached.' },
  ] }] };
  const runtime = createLocalFolderRuntime(conversation, () => null, {
    checkAgentFolder: (...args) => store.check(...args),
    grantAgentPaths: () => { grants += 1; throw new Error('Must not grant broader access'); },
  });
  const request = { path: root, reason: 'The workbook could not be read' };
  const preview = await runtime.previewFolderAccess(request);
  assert.equal(preview.ok, false);
  assert.match(preview.error, /Do not request a parent folder/);
  const applied = await runtime.grantFolderAccess(request, root);
  assert.equal(applied.status, 'failed');
  assert.equal(grants, 0);
  // Permission to inspect an unrelated project directory still uses the normal card.
  const unrelated = path.join(root, 'different-project');
  await fs.mkdir(unrelated);
  assert.equal((await runtime.previewFolderAccess({ path: unrelated, reason: 'Inspect another project' })).ok, true);
});

test('parent-folder checks cover failed previews and revoked files with Windows path boundaries', () => {
  for (const failure of [{ error: 'Unsupported' }, { revoked: true }, { preview: '{"error":"Corrupt workbook"}' }]) {
    const conversation = { messages: [{ role: 'user', attachments: [{ path: 'C:\\Users\\me\\Documents\\0801.xlsm', kind: 'table', pathType: 'file', ...failure }] }] };
    assert.match(folderAccessRequestError(conversation, 'c:/users/ME/documents/'), /parent folder/);
    assert.equal(folderAccessRequestError(conversation, 'C:/Users/me/Documents2'), '');
    assert.equal(folderAccessRequestError(conversation, 'C:/Users/me/Documents/other'), '');
  }
});

test('folder approval rechecks the canonical location before granting legitimate access', async () => {
  const granted = [];
  const runtime = createLocalFolderRuntime({ id: 'chat-one', messages: [] }, () => null, {
    checkAgentFolder: async () => ({ path: 'C:/project', name: 'project' }),
    grantAgentPaths: async (...args) => { granted.push(args); return [{ grantId: 'g1', path: 'C:/project', kind: 'folder' }]; },
  });
  assert.equal((await runtime.grantFolderAccess({ path: 'C:/project' }, 'C:/old-location')).status, 'failed');
  assert.equal(granted.length, 0);
  assert.equal((await runtime.grantFolderAccess({ path: 'C:/project' }, 'C:/project')).status, 'allowed');
  assert.equal(granted.length, 1);
});

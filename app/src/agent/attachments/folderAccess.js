/** Desktop-only, pure Node. All local path authority and content budgets live here. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { attachmentKind, attachmentProblem, looksLikeText } from './attachmentTypes.js';

export const MAX_PROJECT_FILES = 100;
const MAX_SCAN_ENTRIES = 5000;
const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const clamp = (value, fallback, maximum) => Math.min(maximum, Math.max(1, Math.floor(Number(value) || fallback)));
const keyOf = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const slash = (value) => value.split(path.sep).join('/');
const same = (a, b) => keyOf(a) === keyOf(b);
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function checkPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid local path.');
  if (process.platform === 'win32' && (/^\\\\[.?]\\/.test(value) || value.replace(/^[A-Za-z]:/, '').includes(':'))) {
    throw new Error('Device paths and alternate data streams cannot be read.');
  }
}

function systemPaths() {
  return process.platform === 'win32'
    ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData']
    : ['/System', '/usr', '/etc', '/bin', '/sbin', '/dev', '/proc', '/sys', '/Library'];
}

export function isTooBroad(value, home = os.homedir()) {
  const root = path.parse(value).root;
  return same(value, root) || same(value, home) || systemPaths().some((system) => inside(system, value));
}

export async function resolveInside(root, relative = '') {
  checkPath(relative || '.');
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('Use a relative path inside the authorized folder.');
  const lexical = path.resolve(root, relative || '.');
  if (!inside(root, lexical)) throw new Error('The path is outside the authorized folder.');
  const resolved = await fs.realpath(lexical);
  if (!inside(root, resolved)) throw new Error('The link points outside the authorized folder.');
  return resolved;
}

/** Small glob language: *, ** and ?. No user-supplied regex executes on the main thread. */
export function globMatcher(pattern = '**/*') {
  if (typeof pattern !== 'string' || pattern.length > 256 || pattern.includes('..') || pattern.startsWith('/')) throw new Error('Invalid glob pattern.');
  const tokens = [];
  pattern = process.platform === 'win32' ? pattern.toLowerCase() : pattern;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      i += 1;
      if (pattern[i + 1] === '/') { tokens.push({ kind: 'dirs' }); i += 1; }
      else tokens.push({ kind: 'all' });
    } else if (ch === '*') tokens.push({ kind: 'star' });
    else if (ch === '?') tokens.push({ kind: 'any' });
    else tokens.push({ kind: 'literal', value: ch });
  }
  // Memoized wildcard matching avoids converting arbitrary globs to backtracking regexes.
  return { test(input) {
    const value = process.platform === 'win32' ? input.toLowerCase() : input;
    const memo = new Map();
    function match(tokenIndex, offset) {
      const key = tokenIndex * (value.length + 1) + offset;
      if (memo.has(key)) return memo.get(key);
      const token = tokens[tokenIndex];
      let result;
      if (!token) result = offset === value.length;
      else if (token.kind === 'dirs') {
        result = match(tokenIndex + 1, offset);
        for (let cut = value.indexOf('/', offset); !result && cut >= 0; cut = value.indexOf('/', cut + 1)) result = match(tokenIndex + 1, cut + 1);
      } else if (token.kind === 'star' || token.kind === 'all') {
        result = match(tokenIndex + 1, offset) || (offset < value.length && (token.kind === 'all' || value[offset] !== '/') && match(tokenIndex, offset + 1));
      } else result = offset < value.length && (token.kind === 'any' ? value[offset] !== '/' : token.value === value[offset]) && match(tokenIndex + 1, offset + 1);
      memo.set(key, Boolean(result));
      return Boolean(result);
    }
    return match(0, 0);
  } };
}

export function fileImportance(value) {
  const name = value.split('/').pop().toLowerCase();
  if (/^readme(?:\.|$)/.test(name)) return 0;
  if (/^(?:requirements.*\.txt|environment.*\.ya?ml|pyproject\.toml|package\.json|setup\.(?:py|cfg)|dockerfile|makefile)$/.test(name)) return 1;
  if (/^(?:main|app|cli|run|train|predict|inference|pipeline)(?:[_.-]|$)/.test(name)) return 2;
  if (/(?:prompt|evaluat|metric|score|model|generat|process|dataset)/i.test(value)) return 3;
  if (/\.(?:py|js|ts|mjs|r|jl|sh|md|yaml|yml|toml|json|jinja|j2)$/i.test(name)) return 4;
  if (/(?:test|spec|example)/i.test(value)) return 5;
  return 6;
}
const importantFirst = (a, b) => fileImportance(a.path) - fileImportance(b.path) || a.path.localeCompare(b.path, 'en');
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.ipynb_checkpoints', 'dist', 'build']);

export async function listFolder(root, options = {}) {
  const start = await resolveInside(root, options.path || options.subpath || '');
  const match = globMatcher(options.pattern || '**/*');
  const maxEntries = clamp(options.max_entries ?? options.maxEntries, 500, MAX_SCAN_ENTRIES);
  const depthLimit = clamp(options.max_depth ?? options.maxDepth, 6, 6);
  const entries = [];
  let scanned = 0;
  let stopped = false;
  let depthTruncated = false;
  const deadline = Date.now() + 10000;
  async function walk(directory, depth) {
    const iterator = await fs.opendir(directory);
    try {
      for await (const item of iterator) {
        if (++scanned > MAX_SCAN_ENTRIES || Date.now() > deadline) { stopped = true; break; }
        if (!options.include_hidden && !options.includeHidden && (item.name.startsWith('.') || SKIP.has(item.name))) continue;
        let real;
        let stat;
        const absolute = path.join(directory, item.name);
        try { real = await resolveInside(root, path.relative(root, absolute)); stat = await fs.stat(real); } catch (_) { continue; }
        if (!stat.isFile() && !stat.isDirectory()) continue;
        const relative = slash(path.relative(root, absolute));
        const folder = stat.isDirectory();
        if (match.test(relative)) entries.push({ path: relative, kind: folder ? 'folder' : attachmentKind(item.name) || 'unknown', size: stat.size, modified: stat.mtimeMs });
        if (folder && options.recursive && !item.isSymbolicLink()) {
          if (depth < depthLimit) await walk(real, depth + 1);
          else depthTruncated = true;
        }
        if (stopped) break;
      }
    } finally { /* for-await closes the directory, including on early return. */ }
  }
  await walk(start, 1);
  entries.sort(importantFirst);
  const files = entries.filter((entry) => entry.kind !== 'folder').length;
  return { entries: entries.slice(0, maxEntries), total: entries.length, file_count: files,
    truncated: stopped || entries.length > maxEntries || depthTruncated, scan_truncated: stopped || depthTruncated,
    file_limit: MAX_PROJECT_FILES, priority_note: 'Read at most 100 distinct local files per conversation. README, dependencies, entry points and core/evaluation code come first. Listings do not consume this budget.' };
}

// Every regex evaluation runs in a killable worker, including pathological expressions.
const SEARCH_WORKER = `const {parentPort,workerData}=require('node:worker_threads');
let re; try { if(workerData.regex) re=new RegExp(workerData.query,workerData.caseSensitive?'':'i'); }
catch(e) { parentPort.postMessage({error:'Invalid regular expression: '+e.message}); }
parentPort.postMessage({ready:true});
parentPort.on('message', ({text,limit})=>{try {
 const matches=[]; let line=1,start=0;
 for(let end=0;end<=text.length;end++) { if(end!==text.length&&text[end]!=='\\n') continue;
  const value=text.slice(start,end).replace(/\\r$/,'');
  const hit=re?re.test(value):(workerData.caseSensitive?value.includes(workerData.query):value.toLowerCase().includes(workerData.query.toLowerCase()));
  if(hit) matches.push({line,text:value.slice(0,300)});
  if(matches.length>=limit) break;
  start=end+1;line++;
 } parentPort.postMessage({matches});
}catch(e){parentPort.postMessage({error:e.message});}});`;

/** Persist grants independently of message previews; revoked grants never resurrect on restart. */
export function createFolderAccessStore(storagePath, { home = os.homedir(), importFiles } = {}) {
  let state;
  let loading;
  let queue = Promise.resolve();
  const snapshots = new Map();
  const canonicalHome = fs.realpath(home).catch(() => path.resolve(home));
  const canonicalSystems = Promise.all(systemPaths().map((system) => fs.realpath(system).catch(() => path.resolve(system))));
  async function tooBroad(value) {
    return isTooBroad(value, await canonicalHome) || (await canonicalSystems).some((system) => inside(system, value));
  }
  async function load() {
    if (state) return state;
    return loading ||= (async () => {
      let loaded;
      try { loaded = JSON.parse(await fs.readFile(storagePath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; loaded = { grants: [], reads: {} }; }
      if (!Array.isArray(loaded.grants) || !loaded.reads || typeof loaded.reads !== 'object') throw new Error('Invalid local path grant store.');
      state = loaded;
      return state;
    })();
  }
  async function save() {
    const data = JSON.stringify(await load());
    queue = queue.catch(() => {}).then(async () => {
      const temporary = `${storagePath}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      await fs.writeFile(temporary, data, { mode: 0o600 });
      // Windows antivirus/indexers can briefly hold the previous file without delete sharing.
      try {
        for (let attempt = 0; ; attempt += 1) {
          try { await fs.rename(temporary, storagePath); break; }
          catch (error) {
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 8) throw error;
            await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
          }
        }
      } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    });
    await queue;
  }
  function session(value) {
    if (typeof value !== 'string' || !/^[\w-]{1,160}$/.test(value)) throw new Error('A valid conversation id is required.');
    return value;
  }
  async function grantFor(conversation, id) {
    session(conversation);
    const grant = (await load()).grants.find((item) => item.id === id && item.conversationId === conversation);
    if (!grant) throw new Error('Local path access was removed or belongs to another conversation. Ask the user to provide the path again.');
    const real = await fs.realpath(grant.path);
    if (!same(real, grant.path) || await tooBroad(real)) throw new Error('The authorized path changed or is no longer readable.');
    return grant;
  }
  async function targetFor(conversation, id, relative = '') {
    const grant = await grantFor(conversation, id);
    if (grant.type === 'file' && relative) throw new Error('A file grant cannot read other files.');
    const absolute = grant.type === 'folder' ? await resolveInside(grant.path, relative) : grant.path;
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Only regular files can be read.');
    let kind = attachmentKind(absolute);
    if (!kind) {
      const handle = await fs.open(absolute, 'r');
      try { const sample = Buffer.alloc(8192); const { bytesRead } = await handle.read(sample, 0, sample.length, 0); if (looksLikeText(sample.subarray(0, bytesRead))) kind = 'text'; }
      finally { await handle.close(); }
    }
    const problem = attachmentProblem(kind, stat.size);
    if (problem) throw new Error(problem);
    return { grant, absolute, stat, kind };
  }
  async function read(conversation, id, relative = '', { importing = false } = {}) {
    const target = await targetFor(conversation, id, relative);
    const { grant, absolute, kind } = target;
    const dataState = await load();
    const readKey = keyOf(absolute);
    const used = dataState.reads[conversation] ||= [];
    if (!importing && !used.includes(readKey)) {
      if (used.length >= MAX_PROJECT_FILES) throw new Error('The 100-file local project reading limit has been reached in this conversation. Use what was read; report remaining files. Dataset imports are still available.');
      used.push(readKey);
      await save();
    }
    const handle = await fs.open(absolute, 'r');
    let bytes;
    try {
      const stat = await handle.stat();
      const problem = attachmentProblem(kind, stat.size);
      if (!stat.isFile() || problem) throw new Error(problem || 'Only regular files can be read.');
      // Bounded allocation even if a file grows while being read.
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      bytes = bytes.subarray(0, offset);
      const current = await grantFor(conversation, id);
      const now = grant.type === 'folder' ? await resolveInside(current.path, relative) : await fs.realpath(current.path);
      if (!same(now, absolute)) throw new Error('The file changed location while being read.');
      const currentStat = await fs.stat(now);
      if (currentStat.ino !== stat.ino || currentStat.dev !== stat.dev) throw new Error('The file was replaced while being read.');
    } finally { await handle.close(); }
    return { data: bytes, kind, size: bytes.length, name: path.basename(relative || grant.path), path: relative, files_read: used.length, file_limit: MAX_PROJECT_FILES };
  }
  async function list(conversation, id, options = {}) {
    const grant = await grantFor(conversation, id);
    if (grant.type !== 'folder') throw new Error('This authorization is for a file, not a folder.');
    const result = await listFolder(grant.path, { ...options, max_entries: clamp(options.max_entries, 500, 500) });
    let chars = 0;
    const shown = [];
    for (const entry of result.entries) {
      chars += JSON.stringify(entry).length;
      if (chars > 18000) { result.truncated = true; break; }
      shown.push(entry);
    }
    result.entries = shown;
    await grantFor(conversation, id);
    return { ...result, files_read: (await load()).reads[conversation]?.length || 0 };
  }
  async function selectedFiles(conversation, id, options = {}) {
    const grant = await grantFor(conversation, id);
    if (grant.type !== 'folder') throw new Error('A folder grant is required.');
    const inventory = await listFolder(grant.path, { path: options.path, pattern: options.pattern, recursive: options.recursive !== false, include_hidden: options.include_hidden, max_entries: MAX_SCAN_ENTRIES });
    return { ...inventory, entries: inventory.entries.filter((item) => item.kind !== 'folder') };
  }
  return {
    async grant(conversation, groups) {
      session(conversation);
      const results = [];
      for (const group of (Array.isArray(groups) ? groups : []).slice(0, 20)) {
        const candidates = typeof group === 'string' ? [group] : group?.candidates;
        for (const candidate of (Array.isArray(candidates) ? candidates : []).slice(0, 12)) {
          try {
            checkPath(candidate);
            const expanded = candidate.startsWith('~/') ? path.join(home, candidate.slice(2)) : candidate;
            if (!path.isAbsolute(expanded)) throw new Error('Use an absolute local path.');
            const real = await fs.realpath(expanded);
            if (await tooBroad(real)) { results.push({ name: candidate, path: candidate, error: 'Not readable: too broad — name a subfolder' }); break; }
            const stat = await fs.stat(real);
            if (!stat.isDirectory() && !stat.isFile()) throw new Error('Only regular files and folders can be authorized.');
            if (stat.isFile()) {
              try { await targetKindCheck(real, stat); }
              catch (error) {
                results.push({ name: path.basename(real), path: real, pathType: 'file', kind: attachmentKind(real) || 'unsupported', error: error.message });
                break;
              }
            }
            const record = { id: randomUUID(), conversationId: conversation, path: real, type: stat.isDirectory() ? 'folder' : 'file', grantedAt: Date.now() };
            (await load()).grants.push(record);
            await save();
            results.push({ grantId: record.id, path: real, pathType: record.type, name: path.basename(real), kind: stat.isDirectory() ? 'folder' : attachmentKind(real) || 'text', size: stat.size });
            break;
          } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
            results.push({ name: candidate, path: candidate, error: error.message }); break;
          }
        }
      }
      return results;
    },
    async revoke(conversation, id) {
      session(conversation);
      const data = await load();
      data.grants = data.grants.filter((item) => item.conversationId !== conversation || (id && item.id !== id));
      if (!id) delete data.reads[conversation];
      for (const [token, snapshot] of snapshots) if (snapshot.conversation === conversation && (!id || snapshot.grantId === id)) snapshots.delete(token);
      await save();
      return { ok: true };
    },
    async check(conversation, raw) {
      session(conversation); checkPath(raw);
      const real = await fs.realpath(raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw);
      if (await tooBroad(real)) throw new Error('Not readable: too broad — name a subfolder');
      if (!(await fs.stat(real)).isDirectory()) throw new Error('Choose a folder.');
      return { path: real, name: path.basename(real) };
    },
    read, list,
    async batch(conversation, id, options = {}) {
      const inventory = await selectedFiles(conversation, id, options);
      const start = Math.max(0, Math.floor(Number(options.cursor) || 0));
      const count = clamp(options.max_files, 30, 30);
      // Return descriptors, not bytes. Each subsequent read still enforces the shared budget.
      return { files: inventory.entries.slice(start, start + count), total_files: inventory.file_count,
        next_cursor: start + count < inventory.entries.length ? String(start + count) : null,
        scan_truncated: inventory.scan_truncated, file_limit: MAX_PROJECT_FILES };
    },
    async search(conversation, id, options = {}) {
      const query = String(options.query || '');
      if (!query || query.length > 1000) throw new Error('Supply a search query of 1–1000 characters.');
      const deadline = Date.now() + clamp(options.time_limit_ms, 10000, 10000);
      const inventory = await selectedFiles(conversation, id, options);
      const max = clamp(options.max_results, 200, 200);
      const matches = [];
      let filesSearched = 0;
      let bytesScanned = 0;
      let timedOut = false;
      let budgetError = '';
      let resultChars = 0;
      let outputTruncated = false;
      const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { query, regex: Boolean(options.regex), caseSensitive: Boolean(options.case_sensitive) } });
      let workerError;
      worker.on('error', (error) => { workerError = error.message; });
      worker.on('message', (result) => { if (result.error) workerError = result.error; });
      try {
        const ready = await new Promise((resolve) => {
          const listener = (message) => { clearTimeout(timer); worker.off('message', listener); resolve(message); };
          const timer = setTimeout(() => { worker.off('message', listener); resolve({ timedOut: true }); }, Math.max(1, deadline - Date.now()));
          worker.on('message', listener);
        });
        if (ready.error) throw new Error(ready.error);
        if (ready.timedOut) timedOut = true;
        for (const entry of inventory.entries) {
          if (timedOut) break;
          if (Date.now() >= deadline) { timedOut = true; break; }
          if (!['text', 'unknown'].includes(entry.kind) && !/\.(?:csv|tsv|json|jsonl|ndjson)$/i.test(entry.path)) continue;
          if (entry.size > 20 * 1024 * 1024 || bytesScanned + entry.size > 50 * 1024 * 1024) { budgetError = 'Search byte limit reached.'; break; }
          let file;
          try { file = await read(conversation, id, entry.path); }
          catch (error) { if (/100-file|access was removed/.test(error.message)) { budgetError = error.message; break; } continue; }
          if (!looksLikeText(file.data.subarray(0, 8192))) continue;
          bytesScanned += file.data.length;
          filesSearched += 1;
          const result = await new Promise((resolve) => {
            const listener = (message) => { clearTimeout(timer); worker.off('message', listener); resolve(message); };
            const timer = setTimeout(() => { worker.off('message', listener); resolve({ timedOut: true }); }, Math.max(1, deadline - Date.now()));
            worker.on('message', listener);
            worker.postMessage({ text: file.data.toString('utf8'), limit: max - matches.length });
          });
          if (result.timedOut) { timedOut = true; break; }
          if (result.error || workerError) throw new Error(result.error || workerError);
          for (const match of result.matches) {
            const item = { path: entry.path, ...match };
            resultChars += JSON.stringify(item).length;
            if (resultChars > 18000) { outputTruncated = true; break; }
            matches.push(item);
          }
          if (matches.length >= max || outputTruncated) break;
        }
        await grantFor(conversation, id);
        return { matches, filesSearched, files_read: (await load()).reads[conversation]?.length || 0, file_limit: MAX_PROJECT_FILES,
          truncated: timedOut || outputTruncated || Boolean(budgetError) || inventory.scan_truncated || matches.length >= max, timedOut, ...(budgetError ? { note: budgetError } : {}) };
      } finally { await worker.terminate(); }
    },
    async snapshot(conversation, id, options = {}) {
      if (Boolean(options.files) === Boolean(options.pattern)) throw new Error('Choose either files or pattern.');
      let names;
      if (options.files) {
        if (!Array.isArray(options.files) || !options.files.length) throw new Error('files must be a non-empty array.');
        names = [...new Set(options.files)];
      } else {
        const inventory = await selectedFiles(conversation, id, options);
        if (inventory.scan_truncated) throw new Error('Folder scan was truncated. Use a narrower folder or explicit file list.');
        names = inventory.entries.map((item) => item.path);
      }
      if (!names.length || names.length > MAX_IMPORT_FILES) throw new Error('Import 1–500 files at a time.');
      const files = [];
      let total = 0;
      for (const name of names) {
        const target = await targetFor(conversation, id, name);
        if (!['table', 'pdf', 'image'].includes(target.kind)) throw new Error('Only tables, images and PDFs can be imported.');
        total += target.stat.size;
        if (total > MAX_IMPORT_BYTES) throw new Error('An import must be at most 512 MB.');
        const file = await read(conversation, id, name, { importing: true });
        files.push({ id: `local-${files.length + 1}`, name: file.name, relativePath: name, kind: file.kind, size: file.size,
          hash: createHash('sha256').update(file.data).digest('hex') });
      }
      const kinds = new Set(files.map((file) => file.kind));
      if (kinds.size !== 1 || (kinds.has('table') && files.length !== 1)) throw new Error('Import one table, a batch of images or a batch of PDFs, not a mix.');
      const token = randomUUID();
      // Snapshots intentionally expire on restart; an old pending proposal needs a fresh preview.
      snapshots.set(token, { conversation, grantId: id, options: structuredClone(options), files });
      if (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
      return { token, files, total_bytes: total };
    },
    async useSnapshot(conversation, token, { store = false, relativePath } = {}) {
      const snapshot = snapshots.get(token);
      if (!snapshot || snapshot.conversation !== conversation) throw new Error('The import preview expired. Ask the Agent for a new proposal.');
      if (snapshot.options.pattern) {
        const inventory = await selectedFiles(conversation, snapshot.grantId, snapshot.options);
        const current = inventory.entries.map((item) => item.path).sort();
        if (inventory.scan_truncated || JSON.stringify(current) !== JSON.stringify(snapshot.files.map((item) => item.relativePath).sort())) throw new Error('The import file list changed. Request a new preview before applying.');
      }
      const paths = [];
      let selected;
      for (const item of snapshot.files) {
        const file = await read(conversation, snapshot.grantId, item.relativePath, { importing: true });
        if (createHash('sha256').update(file.data).digest('hex') !== item.hash) throw new Error('An import file changed. Request a new preview before applying.');
        const target = await targetFor(conversation, snapshot.grantId, item.relativePath);
        paths.push(target.absolute);
        if (item.relativePath === relativePath) selected = file;
      }
      if (relativePath != null) {
        if (!selected) throw new Error('That file is not in this import preview.');
        return selected;
      }
      const assets = store && snapshot.files[0].kind !== 'table' ? await importFiles(paths, snapshot.files[0].kind) : undefined;
      return { files: snapshot.files, ...(assets ? { assets } : {}) };
    },
  };
}

async function targetKindCheck(real, stat) {
  let kind = attachmentKind(real);
  if (!kind) {
    const handle = await fs.open(real, 'r');
    try { const sample = Buffer.alloc(8192); const { bytesRead } = await handle.read(sample, 0, sample.length, 0); if (looksLikeText(sample.subarray(0, bytesRead))) kind = 'text'; }
    finally { await handle.close(); }
  }
  const problem = attachmentProblem(kind, stat.size);
  if (problem) throw new Error(problem);
}

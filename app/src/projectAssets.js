import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';

export const YC_EXTENSION = '.yc';
const BUNDLE_VERSION = 1;

export const assetRootFor = (file) => file.slice(0, file.length - path.extname(file).length) + '.assets';
export const isBundledProjectFile = (file) => path.extname(String(file || '')).toLowerCase() === YC_EXTENSION;

async function replaceFile(temp, file) {
  try {
    await fs.rename(temp, file);
    return;
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }

  const backup = file + '.' + crypto.randomUUID() + '.old';
  try {
    await fs.rename(file, backup);
    try {
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rename(backup, file).catch(() => {});
      throw error;
    }
    await fs.unlink(backup).catch(() => {});
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function createTempAssetRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-studio-yc-'));
  await fs.mkdir(path.join(root, 'originals'), { recursive: true });
  return root;
}

export async function checkedAssetPath(root, relative) {
  const base = await fs.realpath(root);
  const file = await fs.realpath(path.resolve(base, relative));
  const rel = path.relative(base, file);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('Image is outside the project resource folder.');
  return file;
}

export class ProjectAssets {
  constructor({ decodeImage, registerSession }) {
    this.decodeImage = decodeImage;
    this.registerSession = registerSession;
    this.file = null;
    this.assets = {};
    this.assetRoot = null;
    this.tempAssetRoot = null;
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async setAssetRoot(root, { temporary = false } = {}) {
    const previousTemp = this.tempAssetRoot;
    this.assetRoot = root;
    this.tempAssetRoot = temporary ? root : null;
    if (previousTemp && previousTemp !== root) {
      await fs.rm(previousTemp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async ensureAssetRoot(file = this.file) {
    if (!file) throw new Error('Create or open a project first.');
    if (isBundledProjectFile(file)) {
      if (!this.assetRoot) {
        await this.setAssetRoot(await createTempAssetRoot(), { temporary: true });
      }
      await fs.mkdir(path.join(this.assetRoot, 'originals'), { recursive: true });
      return this.assetRoot;
    }
    const root = assetRootFor(file);
    await this.setAssetRoot(root, { temporary: false });
    return root;
  }

  async readAssetData(id, asset) {
    if (!this.file) throw new Error('Create or open a project first.');
    const root = this.assetRoot || (isBundledProjectFile(this.file) ? await this.ensureAssetRoot(this.file) : assetRootFor(this.file));
    const file = await checkedAssetPath(root, asset.path);
    const data = await fs.readFile(file);
    if ('sha256:' + crypto.createHash('sha256').update(data).digest('hex') !== id) throw new Error(`Image changed: ${asset.name}`);
    return data;
  }

  async readBundlePayload(file) {
    try {
      const payload = JSON.parse(await fs.readFile(file, 'utf8'));
      return payload && typeof payload === 'object' && payload.bundleVersion === BUNDLE_VERSION ? payload : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async load(file) {
    return this.enqueue(() => this._loadInner(file));
  }

  // Shared by load() and merge() below — merge() runs inside its own enqueue()d operation and
  // must call this directly (not through load(), which would re-enter enqueue() and deadlock
  // against the operation it's already running inside of).
  async _loadInner(file) {
    const resolved = path.resolve(file);
    const payload = JSON.parse(await fs.readFile(resolved, 'utf8'));
    const bundled = payload && typeof payload === 'object' && payload.bundleVersion === BUNDLE_VERSION && payload.project;
    const state = bundled ? payload.project : payload;
    if (state.schemaVersion > 2) throw new Error('This project requires a newer version of AnnoBio.');
    this.file = resolved;
    this.assets = state.assets || {};
    if (bundled) {
      const root = await createTempAssetRoot();
      for (const [id, asset] of Object.entries(this.assets)) {
        const encoded = payload.assetBlobs?.[id];
        if (!encoded) throw new Error(`Missing bundled image data: ${asset.name || id}`);
        const target = path.join(root, asset.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.from(encoded, 'base64'));
      }
      await this.setAssetRoot(root, { temporary: true });
    } else {
      await this.setAssetRoot(assetRootFor(resolved), { temporary: false });
    }
    return state;
  }

  /**
   * Adds sourceFile's nodes, connections and images into targetFile's canvas, alongside
   * whatever is already there — nothing in targetFile is removed or overwritten. Both files
   * must be bundled .yc projects (the desktop counterpart of backend/project_store.py's
   * /merge endpoint; see that module's docstring for why plain array-concat + asset-dict-union
   * is safe here without rewriting any ids).
   */
  async merge(targetFile, sourceFile) {
    return this.enqueue(async () => {
      const resolvedTarget = path.resolve(targetFile);
      const resolvedSource = path.resolve(sourceFile);
      if (resolvedTarget === resolvedSource) throw new Error('Cannot merge a project into itself.');
      if (!isBundledProjectFile(resolvedTarget) || !isBundledProjectFile(resolvedSource)) {
        throw new Error('Merge only supports .yc project files.');
      }
      const targetPayload = await this.readBundlePayload(resolvedTarget);
      const sourcePayload = await this.readBundlePayload(resolvedSource);
      if (!targetPayload?.project) throw new Error('Target project file is missing or invalid.');
      if (!sourcePayload?.project) throw new Error('Source project file is missing or invalid.');

      const targetState = { ...targetPayload.project };
      const sourceState = { ...sourcePayload.project };
      const targetNodes = Array.isArray(targetState.nodes) ? targetState.nodes.slice() : [];
      const sourceNodes = (Array.isArray(sourceState.nodes) ? sourceState.nodes : []).map((n) => ({ ...n }));

      // Shift the incoming nodes to sit to the right of whatever's already on the canvas, so
      // they land in open space instead of stacked on top of existing ones.
      if (targetNodes.length && sourceNodes.length) {
        const targetRightEdge = Math.max(...targetNodes.map((n) => n.left || 0));
        const sourceLeftEdge = Math.min(...sourceNodes.map((n) => n.left || 0));
        const offset = (targetRightEdge + 400) - sourceLeftEdge;
        for (const node of sourceNodes) node.left = (node.left || 0) + offset;
      }

      targetState.nodes = targetNodes.concat(sourceNodes);
      targetState.connections = (targetState.connections || []).concat(sourceState.connections || []);

      // Images are embedded as base64 (assetBlobs), keyed by the sha256 of their bytes — a
      // matching id is guaranteed to already be the same image, so merging is a plain union,
      // no file-copying needed the way the web build's separate-files-on-disk format requires.
      const targetAssets = { ...(targetState.assets || {}) };
      const sourceAssets = sourceState.assets || {};
      const targetBlobs = { ...(targetPayload.assetBlobs || {}) };
      const sourceBlobs = sourcePayload.assetBlobs || {};
      for (const [id, asset] of Object.entries(sourceAssets)) {
        if (targetAssets[id]) continue;
        const blob = sourceBlobs[id];
        if (!blob) continue; // source file itself is missing this image's data; skip rather than fail the whole merge
        targetAssets[id] = asset;
        targetBlobs[id] = blob;
      }
      targetState.assets = targetAssets;

      const payload = {
        bundleVersion: BUNDLE_VERSION,
        project: { ...targetState, schemaVersion: 2 },
        assetBlobs: targetBlobs,
        agentSession: targetPayload.agentSession || null,
      };
      const temp = resolvedTarget + '.' + crypto.randomUUID() + '.tmp';
      await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
      await replaceFile(temp, resolvedTarget);

      // If targetFile is the currently open project, re-materialize its asset root from the
      // file we just wrote so newly merged-in images are readable immediately (not just after
      // the app is restarted) — same code path load() uses, called directly to avoid
      // re-entering enqueue() from inside this already-enqueued operation.
      if (this.file && path.resolve(this.file) === resolvedTarget) {
        return this._loadInner(resolvedTarget);
      }
      return targetState;
    });
  }

  async save(file, state) {
    return this.enqueue(async () => {
      file = path.resolve(file);
      const newProject = !state.nodes?.length;
      const assets = newProject ? {} : this.assets;

      if (isBundledProjectFile(file)) {
        const existingBundle = await this.readBundlePayload(file);
        const assetBlobs = {};
        for (const [id, asset] of Object.entries(assets)) {
          const data = await this.readAssetData(id, asset);
          assetBlobs[id] = data.toString('base64');
        }
        const payload = {
          bundleVersion: BUNDLE_VERSION,
          project: { ...state, schemaVersion: 2, assets },
          assetBlobs,
          agentSession: existingBundle?.agentSession || null,
        };
        const temp = file + '.' + crypto.randomUUID() + '.tmp';
        await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
        await replaceFile(temp, file);
        this.file = file;
        this.assets = assets;
        await this.ensureAssetRoot(file);
        return;
      }

      const sourceRoot = this.assetRoot || (this.file ? assetRootFor(this.file) : null);
      if (sourceRoot && Object.keys(assets).length) {
        const root = assetRootFor(file);
        await fs.mkdir(path.join(root, 'originals'), { recursive: true });
        for (const [id, asset] of Object.entries(assets)) {
          const source = await checkedAssetPath(sourceRoot, asset.path);
          const data = await fs.readFile(source);
          if ('sha256:' + crypto.createHash('sha256').update(data).digest('hex') !== id) throw new Error(`Image changed: ${asset.name}`);
          const dest = path.join(root, 'originals', path.basename(asset.path));
          await fs.writeFile(dest, data);
        }
      }

      const payload = { ...state, schemaVersion: 2, assets };
      try {
        const old = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!old.schemaVersion) await fs.copyFile(file, file + '.v1.bak', 1).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temp = file + '.' + crypto.randomUUID() + '.tmp';
      await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
      await replaceFile(temp, file);
      this.file = file;
      this.assets = assets;
      await this.setAssetRoot(assetRootFor(file), { temporary: false });
    });
  }

  async loadAgentSession(file) {
    return this.enqueue(async () => {
      const resolved = path.resolve(file);
      if (!isBundledProjectFile(resolved)) return null;
      const payload = await this.readBundlePayload(resolved);
      return payload?.agentSession || null;
    });
  }

  async saveAgentSession(file, agentSession) {
    return this.enqueue(async () => {
      const resolved = path.resolve(file);
      if (!isBundledProjectFile(resolved)) return false;
      const payload = await this.readBundlePayload(resolved);
      if (!payload?.project) throw new Error('Project file is missing or invalid.');
      const temp = resolved + '.' + crypto.randomUUID() + '.tmp';
      await fs.writeFile(temp, JSON.stringify({
        ...payload,
        agentSession: agentSession || null,
      }, null, 2), 'utf8');
      await replaceFile(temp, resolved);
      return true;
    });
  }

  /**
   * @param {(string | { buffer: Uint8Array, name: string })[]} files - a file path (existing
   *   behavior), or an in-memory buffer + suggested name for bytes that don't exist as a
   *   standalone file on disk.
   */
  async importFiles(files) {
    return this.enqueue(async () => {
      if (!this.file) throw new Error('Create or open a project first.');
      const root = await this.ensureAssetRoot(this.file);
      await fs.mkdir(path.join(root, 'originals'), { recursive: true });
      const result = [];
      for (const file of files) {
        const isInline = file && typeof file === 'object';
        let data, baseName;
        if (isInline) {
          data = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer);
          baseName = file.name || 'image';
          if (data.length > 30 * 1024 * 1024) throw new Error(`Image must be under 30 MB: ${baseName}`);
        } else {
          const stat = await fs.stat(file);
          if (!stat.isFile() || stat.size > 30 * 1024 * 1024) throw new Error(`Image must be a file under 30 MB: ${path.basename(file)}`);
          data = await fs.readFile(file);
          baseName = path.basename(file);
        }
        const png = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpg = data[0] === 255 && data[1] === 216 && data[2] === 255;
        const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
        if (!png && !jpg && !webp) throw new Error(`Unsupported image: ${baseName}. Use PNG, JPEG or WebP.`);
        if ((png && data.includes(Buffer.from('acTL'))) || (webp && data.includes(Buffer.from('ANIM')))) throw new Error('Animated images are not supported. Import a still image.');
        const image = this.decodeImage(data);
        if (!image || !image.width || !image.height) throw new Error(`Cannot decode image: ${baseName}`);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        const id = 'sha256:' + hash;
        const ext = png ? 'png' : jpg ? 'jpg' : 'webp';
        const relative = `originals/${hash}.${ext}`;
        await fs.writeFile(path.join(root, relative), data, { flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
        this.assets[id] = { path: relative, name: baseName, mime: `image/${jpg ? 'jpeg' : ext}`, bytes: data.length, width: image.width, height: image.height };
        result.push({ id, ...this.assets[id] });
      }
      return result;
    });
  }

  /** @param {string[]} files - PDF file paths, registered as attachments (not parsed). */
  async importPdfFiles(files) {
    return this.enqueue(async () => {
      if (!this.file) throw new Error('Create or open a project first.');
      const root = await this.ensureAssetRoot(this.file);
      await fs.mkdir(path.join(root, 'originals'), { recursive: true });
      const result = [];
      for (const file of files) {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error(`PDF must be a file under 32 MB: ${path.basename(file)}`);
        const data = await fs.readFile(file);
        const baseName = path.basename(file);
        if (data.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`Not a PDF: ${baseName}`);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        const id = 'sha256:' + hash;
        const relative = `originals/${hash}.pdf`;
        await fs.writeFile(path.join(root, relative), data, { flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
        this.assets[id] = { path: relative, name: baseName, mime: 'application/pdf', bytes: data.length };
        result.push({ id, ...this.assets[id] });
      }
      return result;
    });
  }

  /**
   * Deletes any tracked asset NOT in usedIds — nothing on the canvas references it, so it's
   * orphaned (e.g. a dataset built from a bulk PDF import, later deleted, whose extracted images
   * were never referenced anywhere else). Bundled .yc projects have no separate file to delete
   * (the bytes are embedded in the project JSON as assetBlobs); dropping the entry from
   * this.assets is enough, since save() only re-embeds blobs for ids still in this.assets.
   * With dryRun, computes what WOULD be removed without touching anything — used to show a
   * confirm dialog with a count/size before actually deleting (see renderer.js).
   * Caller is responsible for saving the project afterward so the pruned registry persists.
   */
  async pruneUnusedAssets(usedIds, { dryRun = false } = {}) {
    return this.enqueue(async () => {
      if (!this.file) throw new Error('Create or open a project first.');
      const used = new Set(usedIds || []);
      const unused = Object.entries(this.assets).filter(([id]) => !used.has(id));
      if (unused.length === 0) return { removed: [], freedBytes: 0 };
      if (dryRun) {
        return {
          removed: unused.map(([id, asset]) => ({ id, name: asset.name })),
          freedBytes: unused.reduce((sum, [, asset]) => sum + (asset.bytes || 0), 0),
        };
      }
      if (!isBundledProjectFile(this.file)) {
        const root = this.assetRoot || assetRootFor(this.file);
        for (const [, asset] of unused) {
          try {
            await fs.unlink(await checkedAssetPath(root, asset.path));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
      let freedBytes = 0;
      const removed = [];
      for (const [id, asset] of unused) {
        delete this.assets[id];
        freedBytes += asset.bytes || 0;
        removed.push({ id, name: asset.name });
      }
      return { removed, freedBytes };
    });
  }

  async preview(id, thumbnail = true) {
    const asset = this.assets[id];
    if (!asset || !this.file) throw new Error('Asset is not in the current project.');
    const data = await this.readAssetData(id, asset);
    if (asset.mime === 'application/pdf') {
      return { ...asset, url: `data:${asset.mime};base64,${data.toString('base64')}` };
    }
    const image = this.decodeImage(data, thumbnail ? 160 : null);
    return { ...asset, url: image.url || `data:${asset.mime};base64,${data.toString('base64')}` };
  }

  async prepare() {
    await this.queue;
    if (!this.file || !Object.keys(this.assets).length) return {};
    const root = this.assetRoot || (isBundledProjectFile(this.file) ? await this.ensureAssetRoot(this.file) : assetRootFor(this.file));
    return this.registerSession({ root, assets: this.assets });
  }

  async exportDataset(file, content) {
    const base = path.basename(file, path.extname(file));
    const dirs = { images: `${base}.images`, pdf: `${base}.pdfs` };
    for (const dirName of Object.values(dirs)) {
      await fs.mkdir(path.join(path.dirname(file), dirName), { recursive: true });
    }
    const rows = [];
    for (const row of content.rows) {
      const out = [];
      for (const cell of row) {
        const dirName = dirs[cell?.kind];
        if (!dirName) { out.push(String(cell ?? '')); continue; }
        const root = path.join(path.dirname(file), dirName);
        const names = [];
        for (const id of cell.assetIds) {
          const asset = this.assets[id];
          if (!asset) throw new Error('Missing asset: ' + id);
          const data = await this.readAssetData(id, asset);
          const name = path.basename(asset.path);
          await fs.writeFile(path.join(root, name), data);
          names.push(`${dirName}/${name}`);
        }
        out.push(JSON.stringify(names));
      }
      rows.push(out);
    }
    const csv = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    await fs.writeFile(file, '\ufeff' + [content.headers, ...rows].map((row) => row.map(csv).join(',')).join('\r\n'));
    await fs.writeFile(file + '.schema.json', JSON.stringify({ headers: content.headers, columnTypes: content.columnTypes }, null, 2));
  }
}

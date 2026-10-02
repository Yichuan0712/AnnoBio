import { app, BrowserWindow, ipcMain, dialog, screen, nativeImage, shell } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { clampAgentTitle } from './agentTitleLimits.js';
import { BACKEND_PORT } from './backendConfig.js';
import { ProjectAssets, YC_EXTENSION, isBundledProjectFile } from './projectAssets.js';
import { createBackendLog } from './backendLog.js';
const assetToken = crypto.randomBytes(32).toString('hex');
const projectAssets = new ProjectAssets({
  decodeImage(data, width) {
    let img = nativeImage.createFromBuffer(data);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    if (width) img = img.resize({ width: Math.min(width, size.width) });
    return { ...size, url: width ? img.toDataURL() : null };
  },
  async registerSession(body) {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/assets/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Asset-Token': assetToken }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Could not register project images. Restart the app to update the backend.');
    return res.json();
  },
});

ipcMain.handle('assets:import', async (_event, paths) => {
  if (!Array.isArray(paths)) {
    const result = await dialog.showOpenDialog({ title: 'Import images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    paths = result.canceled ? [] : result.filePaths;
  }
  return projectAssets.importFiles(paths);
});

ipcMain.handle('assets:import-pdfs', async (_event, paths) => {
  if (!Array.isArray(paths)) {
    const result = await dialog.showOpenDialog({ title: 'Upload PDFs', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    paths = result.canceled ? [] : result.filePaths;
  }
  return projectAssets.importPdfFiles(paths);
});

ipcMain.handle('assets:prune-unused', async (_event, usedIds, options) => {
  return projectAssets.pruneUnusedAssets(usedIds, options);
});
ipcMain.handle('assets:pick-files', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose images to match',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('assets:pick-pdf-files', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose PDFs to match',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('assets:pick-directory', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose the folder for image paths',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] || null);
});
ipcMain.handle('assets:preview', (_event, id, thumbnail) => projectAssets.preview(id, thumbnail));
ipcMain.handle('assets:prepare', () => projectAssets.prepare());
ipcMain.handle('assets:export-dataset', (_event, file, content) => projectAssets.exportDataset(file, content));
ipcMain.handle('assets:resolve-candidates', async (_event, rows, baseDir) => {
  if (!baseDir) throw new Error('Base directory is required.');
  return (Array.isArray(rows) ? rows : []).map((rawValue, rowIndex) => {
    try {
      const value = String(rawValue || '').trim();
      const rawPaths = value.startsWith('[') ? JSON.parse(value) : (value ? [value] : []);
      if (!Array.isArray(rawPaths) || rawPaths.some((item) => typeof item !== 'string')) {
        throw new Error('Use a path or a JSON array of paths.');
      }
      const files = rawPaths.map((entry) => {
        const resolved = path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry);
        let exists = false;
        try {
          exists = fsSync.existsSync(resolved) && fsSync.statSync(resolved).isFile();
        } catch (_) {}
        return {
          path: resolved,
          name: path.basename(resolved),
          exists,
          source: entry,
        };
      });
      return { ok: true, files };
    } catch (error) {
      return { ok: false, files: [], error: `Row ${rowIndex + 1}: ${error.message}` };
    }
  });
});
ipcMain.handle('assets:resolve-paths', async (_event, rows) => {
  const result = await dialog.showOpenDialog({ title: 'Choose the folder for relative image paths', properties: ['openDirectory'] });
  if (result.canceled) return null;
  const base = result.filePaths[0];
  const output = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      let value = String(rows[i] || '').trim();
      const paths = value.startsWith('[') ? JSON.parse(value) : (value ? [value] : []);
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) throw new Error('Use a path or a JSON array of paths.');
      output.push(await projectAssets.importFiles(paths.map((p) => path.resolve(base, p))));
    } catch (error) { throw new Error(`Row ${i + 1}: ${error.message}`); }
  }
  return output;
});

/**
 * ===== Python backend =====
 * Dev: repo backend/.venv (Scripts/python.exe on Windows, bin/python on macOS/Linux).
 * Packaged: resources/backend/python-embed (python.exe on Windows, bin/python on macOS/Linux).
 */
let pyProc = null;
// The backend's output for the desktop Log tab (backendLog.js); created once the app is ready.
let backendLog = null;

// Dev: find repo root by walking up from __dirname until we see backend/main.py (this repo's backend).
// Packaged: use resourcesPath.
function getRepoRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, '..');
  }
  let dir = __dirname;
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fsSync.existsSync(path.join(dir, 'backend', 'main.py'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '..', '..', '..');
}

function getPythonExe() {
  if (app.isPackaged) {
    const base = process.resourcesPath;
    const backendDir = path.join(base, 'backend');
    if (process.platform === 'win32') {
      return path.join(backendDir, 'python-embed', 'pythonw.exe');
    }
    return path.join(backendDir, 'python-embed', 'bin', 'python');
  }
  const repoRoot = getRepoRoot();
  if (process.platform === 'win32') {
    return path.join(repoRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  }
  return path.join(repoRoot, 'backend', '.venv', 'bin', 'python');
}

function getBackendCwd() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend');
  }
  return path.join(getRepoRoot(), 'backend');
}

function getAgentSessionsDir() {
  return path.join(getBackendCwd(), 'data', 'agent_sessions');
}

function getAgentSessionFile(projectPath) {
  const normalized = String(projectPath || '').trim();
  if (!normalized) return null;
  const hash = crypto
    .createHash('sha256')
    .update(path.resolve(normalized).toLowerCase())
    .digest('hex');
  return path.join(getAgentSessionsDir(), `${hash}.json`);
}

function ycPathFor(projectPath) {
  const resolved = path.resolve(String(projectPath || '').trim());
  return resolved.slice(0, resolved.length - path.extname(resolved).length) + YC_EXTENSION;
}

// Mirrors mapMessageForStorage in agentWindowModal.js: the fields agent/agentLoop.js stores.
function mapAgentMessageForStorage(msg) {
  const out = {
    role: String(msg.role || 'assistant'),
    content: String(msg.content || ''),
  };
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
    out.toolCalls = msg.toolCalls.map((call) => ({
      id: String(call?.id || ''),
      name: String(call?.name || ''),
      arguments: String(call?.arguments || '{}'),
      ...(call?.preview && typeof call.preview === 'object' ? { preview: call.preview } : {}),
    }));
  }
  if (out.role === 'tool') {
    out.toolCallId = String(msg.toolCallId || '');
    out.name = String(msg.name || '');
    out.ok = msg.ok !== false;
    out.label = String(msg.label || '');
    if (msg.answer != null) out.answer = String(msg.answer);
    if (msg.outcome != null) out.outcome = String(msg.outcome);
  }
  return out;
}

function normalizeAgentConversationPayload(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const conversations = Array.isArray(data.conversations)
    ? data.conversations
        .filter((item) => item && typeof item === 'object' && String(item.id || '').trim())
        .map((item) => ({
          ...item,
          id: String(item.id || '').trim(),
          title: clampAgentTitle(String(item.title || '').trim() || 'New Agent'),
          generatedTitle: item.generatedTitle === true,
          updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
          pending: item.pending === true,
          pendingStatus: String(item.pendingStatus || '').trim(),
          unsentDraft: String(item.unsentDraft || ''),
          messages: Array.isArray(item.messages)
            ? item.messages
                .filter((msg) => msg && typeof msg === 'object')
                .map((msg) => mapAgentMessageForStorage(msg))
            : [],
        }))
    : [];
  const activeConversationId = String(data.activeConversationId || '').trim();
  return {
    ...(data.format_version != null ? { format_version: Number(data.format_version) } : {}),
    activeConversationId,
    conversations,
  };
}

async function atomicWriteJson(filePath, payload) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

async function loadLegacyAgentConversationPayload(projectPath) {
  const filePath = getAgentSessionFile(projectPath);
  if (!filePath || !fsSync.existsSync(filePath)) {
    return { activeConversationId: '', conversations: [] };
  }
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return normalizeAgentConversationPayload(JSON.parse(raw));
  } catch (_) {
    return { activeConversationId: '', conversations: [] };
  }
}

function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = out.split(/\r?\n/).filter((s) => s.trim());
      const pids = new Set();
      for (const line of lines) {
        const m = line.match(/\s+(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        try {
          // /T kills the whole process tree — uvicorn --reload spawns a child worker
          // process that a plain /PID /F would otherwise leave orphaned on the port.
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        } catch (_) {}
      }
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch (_) {}
}

function startPythonBackend() {
  if (pyProc) return;

  killProcessOnPort(BACKEND_PORT);
  setTimeout(() => {
    startPythonBackendInner();
  }, 1200);
}

function startPythonBackendInner() {
  if (pyProc) return;

  const cwd = getBackendCwd();
  const pycache = path.join(cwd, '__pycache__');
  if (fsSync.existsSync(pycache)) {
    try {
      fsSync.rmSync(pycache, { recursive: true });
    } catch (_) {}
  }

  const pythonExe = getPythonExe();
  if (!fsSync.existsSync(pythonExe)) {
    const msg = `Python backend not found.\n\nExpected: ${pythonExe}\n\nIf you installed from the setup, try uninstalling and reinstalling.`;
    console.error(msg);
    backendLog?.note(msg.replace(/\n+/g, ' '));
    dialog.showErrorBox('Backend Error', msg);
    return;
  }

  // -X utf8: force UTF-8 stdio on Windows so prompts with U+2011 etc. never raise UnicodeEncodeError in the backend.
  const args = ['-X', 'utf8', '-m', 'uvicorn', 'main:app', '--port', String(BACKEND_PORT)];
  if (!app.isPackaged) {
    args.push('--reload');
  }

  const mainPy = path.join(cwd, 'main.py');
  console.log('[python] backend cwd=', cwd);
  console.log('[python] main.py path=', mainPy);
  pyProc = spawn(pythonExe, args, {
    cwd,
    env: {
      ...process.env,
      PROMPT_STUDIO_ASSET_TOKEN: assetToken,
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    // Piped rather than inherited so the Log tab can show it; backendLog echoes it to the terminal in dev.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backendLog?.note(`Starting backend on port ${BACKEND_PORT}`);
  backendLog?.attach(pyProc);

  pyProc.on('exit', (code) => {
    console.log('[python] exited with code', code);
    backendLog?.note(`Backend exited with code ${code}`);
    pyProc = null;
  });
}

function stopPythonBackend() {
  if (pyProc) {
    const pid = pyProc.pid;
    // Plain .kill() only signals the uvicorn supervisor; with --reload it has a child
    // worker process that would otherwise survive and keep holding BACKEND_PORT.
    if (process.platform === 'win32' && pid) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } catch (_) {
        pyProc.kill();
      }
    } else {
      pyProc.kill();
    }
    pyProc = null;
  }
}

const createWindow = () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const width = Math.max(640, Math.min(1920, Math.round(screenWidth * 0.85)));
  const height = Math.max(480, Math.min(1080, Math.round(screenHeight * 0.88)));
  const mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 640,
    minHeight: 480,
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setMenu(null);

  const sendWindowChromeState = () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendWindowChromeState);
  mainWindow.on('unmaximize', sendWindowChromeState);
  mainWindow.webContents.on('did-finish-load', sendWindowChromeState);

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
};

// Project file IPC
ipcMain.handle('project:new-dialog', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'New Your Canvas',
    defaultPath: app.getPath('documents'),
    filters: [
      { name: 'Your Canvas File', extensions: [YC_EXTENSION.slice(1)] },
      { name: 'Legacy JSON Project', extensions: ['json'] },
    ],
  });
  return canceled ? null : filePath;
});

ipcMain.handle('project:open-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open Your Canvas',
    filters: [
      { name: 'Your Canvas or Legacy JSON', extensions: [YC_EXTENSION.slice(1), 'json'] },
      { name: 'Your Canvas File', extensions: [YC_EXTENSION.slice(1)] },
      { name: 'Legacy JSON Project', extensions: ['json'] },
    ],
    properties: ['openFile'],
  });
  return canceled || !filePaths?.length ? null : filePaths[0];
});

ipcMain.handle('project:save-as-dialog', async (_e, defaultPath) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save Your Canvas As',
    defaultPath: defaultPath || `project${YC_EXTENSION}`,
    filters: [
      { name: 'Your Canvas File', extensions: [YC_EXTENSION.slice(1)] },
      { name: 'Legacy JSON Project', extensions: ['json'] },
    ],
  });
  return canceled ? null : filePath;
});

ipcMain.handle('project:save', async (_e, filePath, state, options) => {
  await projectAssets.save(filePath, state, options);
});

ipcMain.handle('project:load', async (_e, filePath) => {
  const resolved = path.resolve(filePath);
  if (!isBundledProjectFile(resolved) && path.extname(resolved).toLowerCase() === '.json') {
    const migratedPath = ycPathFor(resolved);
    if (fsSync.existsSync(migratedPath)) {
      const state = await projectAssets.load(migratedPath);
      return { state, resolvedPath: migratedPath };
    }
    const state = await projectAssets.load(resolved);
    await projectAssets.save(migratedPath, state);
    const legacyAgentSession = await loadLegacyAgentConversationPayload(resolved);
    await projectAssets.saveAgentSession(migratedPath, legacyAgentSession);
    const migratedState = await projectAssets.load(migratedPath);
    return { state: migratedState, resolvedPath: migratedPath };
  }
  const state = await projectAssets.load(resolved);
  return { state, resolvedPath: resolved };
});

ipcMain.handle('project:pick-merge-source-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a project to merge in',
    filters: [{ name: 'Your Canvas File', extensions: [YC_EXTENSION.slice(1)] }],
    properties: ['openFile'],
  });
  return canceled || !filePaths?.length ? null : filePaths[0];
});

ipcMain.handle('project:merge', async (_e, targetFile, sourceFile) => {
  return projectAssets.merge(targetFile, sourceFile);
});

ipcMain.handle('agent-conversations:load', async (_e, projectPath) => {
  const resolved = String(projectPath || '').trim();
  if (!resolved) return { activeConversationId: '', conversations: [] };
  if (isBundledProjectFile(resolved)) {
    return normalizeAgentConversationPayload(await projectAssets.loadAgentSession(resolved));
  }
  return loadLegacyAgentConversationPayload(resolved);
});

ipcMain.handle('agent-conversations:save', async (_e, projectPath, payload) => {
  const resolved = String(projectPath || '').trim();
  if (!resolved) return { ok: false };
  const normalized = normalizeAgentConversationPayload(payload);
  if (isBundledProjectFile(resolved)) {
    await projectAssets.saveAgentSession(resolved, normalized);
    return { ok: true };
  }
  const filePath = getAgentSessionFile(resolved);
  if (!filePath) return { ok: false };
  await fs.mkdir(getAgentSessionsDir(), { recursive: true });
  await atomicWriteJson(filePath, normalized);
  return { ok: true };
});

// Dataset/table export: save dialog then write file (CSV/TSV = utf8, XLSX = base64)
ipcMain.handle('dialog:show-save', async (_e, opts) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: opts?.title ?? 'Save file',
    defaultPath: opts?.defaultPath ?? undefined,
    filters: Array.isArray(opts?.filters) ? opts.filters : [{ name: 'All Files', extensions: ['*'] }],
  });
  return canceled ? null : filePath;
});

// Process node settings: let the user browse to a Python interpreter (system install or a venv).
ipcMain.handle('dialog:pick-python', async () => {
  const filters = process.platform === 'win32'
    ? [{ name: 'Python interpreter', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
    : [{ name: 'All files', extensions: ['*'] }];
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Python interpreter',
    filters,
    properties: ['openFile'],
  });
  return canceled || !filePaths?.length ? null : filePaths[0];
});

ipcMain.handle('fs:write-file', async (_e, filePath, data, encoding) => {
  const enc = encoding === 'base64' ? 'base64' : 'utf8';
  const buf = enc === 'base64' ? Buffer.from(data, 'base64') : data;
  await fs.writeFile(filePath, buf, enc === 'base64' ? undefined : enc);
});

ipcMain.handle('backend-log:get', () => backendLog?.lines() || []);
ipcMain.handle('backend-log:clear', () => { backendLog?.clear(); });
ipcMain.handle('backend-log:open-folder', () => (backendLog ? shell.openPath(backendLog.dir) : ''));

ipcMain.handle('shell:open-external', (_e, url) => {
  if (typeof url !== 'string' || !url.startsWith('https://openrouter.ai/')) return;
  shell.openExternal(url);
});

ipcMain.handle('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.minimize();
});

ipcMain.handle('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});

ipcMain.handle('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('window:is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return !!win && !win.isDestroyed() && win.isMaximized();
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  backendLog = createBackendLog({
    dir: path.join(app.getPath('userData'), 'logs'),
    tee: !app.isPackaged,
    onLines: (lines) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('backend-log:lines', lines);
    },
  });

  // Start backend first
  startPythonBackend();

  // Then create the UI
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Ensure backend is stopped when quitting.
app.on('before-quit', () => {
  stopPythonBackend();
});

ipcMain.handle('history:index', (_e, projectPath) => projectAssets.loadHistoryIndex(projectPath));
ipcMain.handle('history:record', (_e, projectPath, recordId) => projectAssets.loadHistoryRecord(projectPath, recordId));
ipcMain.handle('history:save-record', (_e, projectPath, record) => projectAssets.saveHistoryRecord(projectPath, record));
ipcMain.handle('history:delete-records', (_e, projectPath, recordId, expectedIds) => projectAssets.deleteHistoryRecords(projectPath, recordId, expectedIds));

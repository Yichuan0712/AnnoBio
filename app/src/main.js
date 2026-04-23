import { app, BrowserWindow, ipcMain, dialog, screen } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { clampAgentTitle } from './agentTitleLimits.js';

/**
 * ===== Python backend =====
 * Dev: repo backend/.venv (Scripts/python.exe on Windows, bin/python on macOS/Linux).
 * Packaged: resources/backend/python-embed (python.exe on Windows, bin/python on macOS/Linux).
 */
const BACKEND_PORT = 8000;
let pyProc = null;

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
          messages: Array.isArray(item.messages)
            ? item.messages
                .filter((msg) => msg && typeof msg === 'object')
                .map((msg) => ({
                  role: String(msg.role || 'assistant'),
                  content: String(msg.content || ''),
                }))
            : [],
        }))
    : [];
  const activeConversationId = String(data.activeConversationId || '').trim();
  return {
    activeConversationId,
    conversations,
  };
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
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
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
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: 'inherit',
    windowsHide: true,
  });

  pyProc.on('exit', (code) => {
    console.log('[python] exited with code', code);
    pyProc = null;
  });
}

function stopPythonBackend() {
  if (pyProc) {
    pyProc.kill();
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
    title: 'New project',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  return canceled ? null : filePath;
});

ipcMain.handle('project:open-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open project',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  return canceled || !filePaths?.length ? null : filePaths[0];
});

ipcMain.handle('project:save-as-dialog', async (_e, defaultPath) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save project as',
    defaultPath: defaultPath || 'project.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  return canceled ? null : filePath;
});

ipcMain.handle('project:save', async (_e, filePath, state) => {
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
});

ipcMain.handle('project:load', async (_e, filePath) => {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
});

ipcMain.handle('agent-conversations:load', async (_e, projectPath) => {
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
});

ipcMain.handle('agent-conversations:save', async (_e, projectPath, payload) => {
  const filePath = getAgentSessionFile(projectPath);
  if (!filePath) return { ok: false };
  const normalized = normalizeAgentConversationPayload(payload);
  await fs.mkdir(getAgentSessionsDir(), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
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

ipcMain.handle('fs:write-file', async (_e, filePath, data, encoding) => {
  const enc = encoding === 'base64' ? 'base64' : 'utf8';
  const buf = enc === 'base64' ? Buffer.from(data, 'base64') : data;
  await fs.writeFile(filePath, buf, enc === 'base64' ? undefined : enc);
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
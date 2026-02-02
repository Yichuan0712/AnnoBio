import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { spawn } from 'node:child_process';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

/**
 * ===== Python backend (dev) =====
 * repo:
 *   ElectronVuePython/
 *     app/
 *       src/main.js  (this file)
 *     backend/
 *       main.py
 *       .venv/Scripts/python.exe
 */
const BACKEND_PORT = 8000;
let pyProc = null;

function getRepoRoot() {
  // dev mode: app.getAppPath() ~= ...\ElectronVuePython\app
  // repo root: its parent folder
  return path.resolve(app.getAppPath(), '..');
}

function getPythonExe() {
  const repoRoot = getRepoRoot();
  return path.join(repoRoot, 'backend', '.venv', 'Scripts', 'python.exe');
}

function getBackendCwd() {
  const repoRoot = getRepoRoot();
  return path.join(repoRoot, 'backend');
}

function startPythonBackend() {
  if (pyProc) return;

  const pythonExe = getPythonExe();
  const cwd = getBackendCwd();

  // Start: python -m uvicorn main:app --port 8000
  pyProc = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'main:app', '--port', String(BACKEND_PORT)],
    {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: 'inherit',
      windowsHide: true,
    }
  );

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
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setMenu(null);

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

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
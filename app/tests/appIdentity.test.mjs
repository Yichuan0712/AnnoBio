import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APP_NAME, WINDOWS_APP_ID, windowsTaskbarDetails } from '../src/appIdentity.js';

test('Windows taskbar identity matches the installer identity', () => {
  const config = fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(config, new RegExp(`^appId: ${WINDOWS_APP_ID.replaceAll('.', '\\.')}\\r?$`, 'm'));
  assert.match(config, new RegExp(`^productName: ${APP_NAME}\\r?$`, 'm'));
});

test('development taskbar relaunch starts the project, with paths containing spaces quoted', () => {
  const details = windowsTaskbarDetails({ executablePath: 'C:\\Program Files\\Electron\\electron.exe', appPath: 'C:\\My Projects\\AnnoBio', isPackaged: false });
  assert.equal(details.relaunchDisplayName, 'AnnoBio');
  assert.equal(details.relaunchCommand, '"C:\\Program Files\\Electron\\electron.exe" "C:\\My Projects\\AnnoBio"');
  assert.equal(details.appIconPath, 'C:\\My Projects\\AnnoBio\\assets\\icon.ico');
});

test('packaged taskbar relaunch uses the app executable and its embedded icon', () => {
  const executablePath = 'C:\\Program Files\\AnnoBio\\AnnoBio.exe';
  const details = windowsTaskbarDetails({ executablePath, appPath: 'C:\\Program Files\\AnnoBio\\resources\\app.asar', isPackaged: true });
  assert.equal(details.relaunchCommand, '"C:\\Program Files\\AnnoBio\\AnnoBio.exe"');
  assert.equal(details.appIconPath, executablePath);
  assert.equal(details.appIconIndex, 0);
});

test('a development app path ending in a backslash does not escape the closing quote', () => {
  const details = windowsTaskbarDetails({ executablePath: 'C:\\Electron\\electron.exe', appPath: 'C:\\', isPackaged: false });
  assert.equal(details.relaunchCommand, '"C:\\Electron\\electron.exe" "C:\\\\"');
});

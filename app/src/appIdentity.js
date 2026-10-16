import path from 'node:path';

export const APP_NAME = 'AnnoBio';
export const WINDOWS_APP_ID = 'com.digitalbiologylab.promptstudio';

// Windows command-line parsing doubles trailing backslashes before a closing quote.
const quotePath = (value) => `"${value.replace(/(\\+)$/, '$1$1')}"`;

export function windowsTaskbarDetails({ executablePath, appPath, isPackaged }) {
  const command = isPackaged ? [executablePath] : [executablePath, appPath];
  return {
    appId: WINDOWS_APP_ID,
    appIconPath: isPackaged ? executablePath : path.win32.join(appPath, 'assets', 'icon.ico'),
    appIconIndex: 0,
    relaunchDisplayName: APP_NAME,
    relaunchCommand: command.map(quotePath).join(' '),
  };
}

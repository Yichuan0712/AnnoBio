export const ABOUT_AFFILIATION = 'Digital Biology Lab, Health Informatics Institute, Morsani College of Medicine, University of South Florida, Tampa, Florida, USA';
export const ABOUT_COPYRIGHT = '© 2026 AnnoBio';

/** The same diagnostic fields appear in the dialog and its clipboard report. */
export function appInfoRows(info) {
  const data = info && typeof info === 'object' ? info : {};
  const value = (key) => typeof data[key] === 'string' && data[key].trim() ? data[key].trim() : 'Unavailable';
  const commit = value('commit');
  return [
    ['Version', value('version')],
    ['Commit', commit + (commit !== 'Unavailable' && data.modified ? ' (modified)' : '')],
    ['Date', value('buildDate')],
    ['Electron', value('electron')],
    ['Chromium', value('chromium')],
    ['Node.js', value('node')],
    ['V8', value('v8')],
    ['OS', value('os')],
  ];
}

export function formatAppInfo(info) {
  return [
    'AnnoBio', '', ...appInfoRows(info).map(([label, value]) => `${label}: ${value}`), '',
    ABOUT_AFFILIATION,
    `${ABOUT_COPYRIGHT} · AnnoBio Non-Commercial License (https://github.com/Yichuan0712/AnnoBio/blob/main/LICENSE)`,
    'Paper coming soon.',
  ].join('\n');
}

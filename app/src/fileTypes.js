/** Shared import/attachment formats. Only list formats with a working reader. */
export const WORKBOOK_FILE_EXTENSIONS = Object.freeze([
  'xlsx', 'xls', 'xlsm', 'xlsb', 'xltx', 'xltm', 'xlt',
  'ods', 'ots', 'fods', 'numbers', 'dbf', 'dif', 'slk', 'sylk',
]);
export const TABLE_FILE_EXTENSIONS = Object.freeze(['csv', 'tsv', 'tab', ...WORKBOOK_FILE_EXTENSIONS, 'json', 'jsonl', 'ndjson']);
export const IMAGE_FILE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp']);
export const DOCUMENT_FILE_EXTENSIONS = Object.freeze([
  'docx', 'docm', 'dotx', 'dotm', 'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'odt', 'ott', 'odp', 'otp',
]);

export function fileExtension(name) {
  return /\.([^./\\]+)$/.exec(String(name || ''))?.[1].toLowerCase() || '';
}

/** The parser to use, shared by Create Dataset and Agent attachments. */
export function tableFileFormat(name) {
  const ext = fileExtension(name);
  if (WORKBOOK_FILE_EXTENSIONS.includes(ext)) return 'workbook';
  if (['jsonl', 'ndjson'].includes(ext)) return 'jsonl';
  if (ext === 'json' || ext === 'csv') return ext;
  return ['tsv', 'tab'].includes(ext) ? 'tsv' : '';
}

export const TABLE_FILE_ACCEPT = TABLE_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(',');
export const IMAGE_FILE_ACCEPT = `${IMAGE_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(',')},image/png,image/jpeg,image/webp`;

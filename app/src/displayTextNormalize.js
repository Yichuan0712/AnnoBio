/**
 * Normalize Unicode dash / hyphen characters to ASCII U+002D before painting UI text.
 * LLMs often emit en dash (U+2013), em dash (U+2014), minus (U+2212), etc.; some system
 * font stacks in Electron render those as missing-glyph boxes. Replacing them avoids
 * tofu without changing the app's primary font family.
 */

const DASH_LIKE =
  /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\u2043\u2E3A\u2E3B\uFE31]/g;

export function normalizeUnicodeDashesForDisplay(str) {
  if (str == null) return '';
  return String(str)
    .replace(/\u00AD/g, '')
    .replace(DASH_LIKE, '-');
}

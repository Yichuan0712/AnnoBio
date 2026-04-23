/**
 * Agent chat titles are shown on one line in the sidebar and main header (~320px / 13px).
 * Keeping within this budget avoids ellipsis, wrapping, and horizontal scroll.
 */
export const AGENT_TITLE_MAX_CHARS = 40;

/**
 * Single line: collapse whitespace, then trim to max length (prefer last word boundary).
 */
export function clampAgentTitle(input, max = AGENT_TITLE_MAX_CHARS) {
  const normalized = String(input || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= max) return normalized;
  const slice = normalized.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const minWordBreak = Math.floor(max * 0.45);
  if (lastSpace >= minWordBreak) return slice.slice(0, lastSpace).trimEnd();
  return slice.trimEnd();
}

/**
 * Theme (light/dark) state and helpers.
 * 高对比模式已注释：仍从存储中迁移 high-contrast → light，并保留常量供外部兼容。
 */

const THEME_KEY = 'app-display-mode';
export const THEME_LIGHT = 'light';
export const THEME_DARK = 'dark';
export const THEME_HIGH_CONTRAST = 'high-contrast';

const THEME_CLASSES = ['dark', 'high-contrast'];

export function getStoredTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'system') return THEME_LIGHT;
  if (stored === 'sepia') {
    localStorage.setItem(THEME_KEY, THEME_LIGHT);
    return THEME_LIGHT;
  }
  if (stored === THEME_HIGH_CONTRAST) {
    localStorage.setItem(THEME_KEY, THEME_LIGHT);
    return THEME_LIGHT;
  }
  return stored || THEME_LIGHT;
}

export function setTheme(mode) {
  const normalized =
    mode === 'sepia' || mode === THEME_HIGH_CONTRAST ? THEME_LIGHT : mode;
  const html = document.documentElement;
  THEME_CLASSES.forEach((c) => html.classList.remove(c));
  if (normalized === THEME_DARK) {
    html.classList.add('dark');
  }
  // 高对比模式已注释（index.css 中 html.high-contrast 已注释），此处不再 add('high-contrast')
  localStorage.setItem(THEME_KEY, normalized);
}

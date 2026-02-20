/**
 * Theme (light/dark/sepia/high-contrast) state and helpers.
 */

const THEME_KEY = 'app-display-mode';
export const THEME_LIGHT = 'light';
export const THEME_DARK = 'dark';
export const THEME_SEPIA = 'sepia';
export const THEME_HIGH_CONTRAST = 'high-contrast';

const THEME_CLASSES = ['dark', 'sepia', 'high-contrast'];

export function getStoredTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'system') return THEME_LIGHT;
  return stored || THEME_LIGHT;
}

export function setTheme(mode) {
  const html = document.documentElement;
  THEME_CLASSES.forEach((c) => html.classList.remove(c));
  if (mode === THEME_DARK) {
    html.classList.add('dark');
  } else if (mode === THEME_SEPIA) {
    html.classList.add('sepia');
  } else if (mode === THEME_HIGH_CONTRAST) {
    html.classList.add('high-contrast');
  }
  localStorage.setItem(THEME_KEY, mode);
}

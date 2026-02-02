/**
 * Theme (light/dark) state and helpers.
 */

const THEME_KEY = 'app-display-mode';
export const THEME_LIGHT = 'light';
export const THEME_DARK = 'dark';

export function getStoredTheme() {
  return localStorage.getItem(THEME_KEY) || THEME_LIGHT;
}

export function setTheme(mode) {
  const html = document.documentElement;
  if (mode === THEME_DARK) {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
  localStorage.setItem(THEME_KEY, mode);
}

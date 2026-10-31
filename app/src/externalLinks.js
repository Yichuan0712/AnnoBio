/** URLs the desktop app may hand to the system browser. */
const CREDENTIAL_HELP_URLS = new Set([
  'https://api.iucnredlist.org/',
  'https://www.guidetopharmacology.org/webServices.jsp',
  'https://console.wenglab.org/docs/getting-started/auth',
  'https://www.synapse.org/PersonalAccessTokens',
]);

/** Source links open only public-looking web URLs, never files or app protocols.
 * The backend separately resolves and pins public IPs before fetching any page. */
export function allowedWebSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')
      || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)) return null;
    return url.href;
  } catch (_) { return null; }
}

/** Delegate source-link clicks so streamed text can update without rebinding handlers. */
export function attachWebSourceLinks(container) {
  const open = (event) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const bridge = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!bridge) return;
    const link = event.target.closest?.('a.agent-web-link');
    if (!link) return;
    event.preventDefault();
    const url = allowedWebSourceUrl(link.href);
    if (!url || !bridge.openWebSource) return;
    Promise.resolve().then(() => bridge.openWebSource(url)).catch(error => console.error('Open web source:', error));
  };
  container.addEventListener('click', open);
  container.addEventListener('auxclick', open);
}

export function allowedExternalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    // OpenRouter OAuth already uses this bridge, with a generated path and query string.
    return url.hostname === 'openrouter.ai' || CREDENTIAL_HELP_URLS.has(url.href) ? url.href : null;
  } catch (_) {
    return null;
  }
}

/** Web anchors retain normal new-tab behavior; desktop links use the existing shell bridge. */
export function attachExternalBrowserLink(link, showError) {
  const open = (event) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const bridge = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!bridge?.openExternal) return;
    event.preventDefault();
    const url = allowedExternalUrl(link.href);
    if (!url) return;
    Promise.resolve().then(() => bridge.openExternal(url)).then((result) => {
      if (result?.error) throw new Error(result.error);
    }).catch((error) => showError?.(`Could not open your browser: ${error.message || error}`));
  };
  link.addEventListener('click', open);
  link.addEventListener('auxclick', open);
}

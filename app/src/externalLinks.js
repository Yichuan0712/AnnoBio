/** URLs the desktop app may hand to the system browser. */
const CREDENTIAL_HELP_URLS = new Set([
  'https://api.iucnredlist.org/',
  'https://www.guidetopharmacology.org/webServices.jsp',
  'https://console.wenglab.org/docs/getting-started/auth',
  'https://www.synapse.org/PersonalAccessTokens',
]);

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

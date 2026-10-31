import { BACKEND_API_BASE } from '../backendConfig.js';

/** The backend bounds network work; this also bounds an unresponsive connection to it. */
export async function requestWebLookup(name, args, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(`${BACKEND_API_BASE}/api/agent/${name === 'web_search' ? 'web-search' : 'webpage'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: controller.signal,
    });
    const body = await response.json();
    return response.ok ? body : { error: typeof body.detail === 'string' ? body.detail : 'The web lookup request was rejected.' };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return { error: controller.signal.aborted ? 'Web lookup timed out. Continue with the information available.' : 'Web lookup could not reach the backend.' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

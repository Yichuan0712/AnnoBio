import { allowedWebSourceUrl } from '../externalLinks.js';

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInline(text) {
  // Tokenize before HTML escaping; inline/fenced code remains literal. Only
  // validated HTTP(S) URLs can produce anchors, with all attributes escaped.
  return String(text ?? '').split(/(`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>`]+)/g).map(part => {
    if (part.startsWith('`') && part.endsWith('`')) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    const markdown = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    const raw = !markdown && /^https?:\/\//.test(part);
    const candidate = markdown ? markdown[2] : raw ? part.replace(/[.,;!?:)*]+$/, '') : '';
    const url = allowedWebSourceUrl(candidate);
    if (url) {
      const label = markdown ? markdown[1] : candidate;
      const tail = raw ? part.slice(candidate.length) : '';
      return `<a class="agent-web-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>${escapeHtml(tail)}`;
    }
    return escapeHtml(part).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }).join('');
}

/**
 * The light formatting the Agent's system prompt allows: fenced code blocks, `inline code` and
 * **bold**, source links and bare HTTP(S) URLs. Other text stays plain (pre-wrap).
 * An unterminated fence, as seen mid-stream, renders as a code block up to the end.
 */
export function formatAgentText(text) {
  const parts = String(text ?? '').split(/^```[^\n]*\n?/m);
  return parts
    .map((part, i) => (i % 2 === 1
      ? `<pre class="agent-window__code"><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`
      : formatInline(part)))
    .join('');
}

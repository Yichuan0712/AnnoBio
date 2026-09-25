function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInline(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * The light formatting the Agent's system prompt allows: fenced code blocks, `inline code` and
 * **bold**. Everything else stays plain text (the bubble keeps line breaks with pre-wrap).
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

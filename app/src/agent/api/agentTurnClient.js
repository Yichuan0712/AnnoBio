import { BACKEND_API_BASE } from '../../backendConfig.js';

/**
 * One streamed model response from POST /api/agent/turn.
 * @param {{credentialId: string, messages: object[], tools: object[], workspaceSummary: string,
 *   signal?: AbortSignal, onText?: (delta: string) => void}} request messages are OpenAI-format
 * @returns {Promise<{text: string, toolCalls: {id: string, name: string, arguments: string}[], finishReason: string}>}
 */
export async function streamAgentTurn({ credentialId, messages, tools, workspaceSummary, signal, onText }) {
  const res = await fetch(`${BACKEND_API_BASE}/api/agent/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credential_id: credentialId,
      messages,
      tools,
      workspace_summary: workspaceSummary,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail || res.statusText || 'Agent request failed');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let toolCalls = [];
  let finishReason = '';

  function handle(event) {
    if (event.type === 'text') {
      text += event.delta;
      if (onText) onText(event.delta);
    } else if (event.type === 'tool_calls') {
      toolCalls = event.tool_calls || [];
    } else if (event.type === 'done') {
      finishReason = event.finish_reason || '';
    } else if (event.type === 'error') {
      throw new Error(event.message || 'Agent request failed');
    }
  }

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
      if (data) handle(JSON.parse(data));
      boundary = buffer.indexOf('\n\n');
    }
  }
  return { text, toolCalls, finishReason };
}

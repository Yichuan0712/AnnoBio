import { BACKEND_API_BASE } from '../../backendConfig.js';

/**
 * One streamed model response from POST /api/agent/turn.
 * @param {{credentialId: string, messages: object[], tools: object[], workspaceSummary: string,
 *   conversationSummary?: string, projectOpen?: boolean, signal?: AbortSignal,
 *   onText?: (delta: string) => void}} request messages are OpenAI-format; conversationSummary
 *   replaces the conversation's earliest messages; projectOpen false adds the no-project section to
 *   the system prompt
 * @returns {Promise<{text: string, toolCalls: {id: string, name: string, arguments: string}[], finishReason: string}>}
 */
export async function streamAgentTurn({ credentialId, messages, tools, workspaceSummary, conversationSummary = '', projectOpen = true, signal, onText }) {
  const res = await fetch(`${BACKEND_API_BASE}/api/agent/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credential_id: credentialId,
      messages,
      tools,
      workspace_summary: workspaceSummary,
      conversation_summary: conversationSummary,
      project_open: projectOpen,
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

/**
 * What one Agent request can hold (GET /api/agent/context): {context_tokens, source, detected_tokens,
 * reply_tokens, system_prompt_tokens}; see historyBudget.js. Null when the backend can't say.
 */
export async function fetchAgentContext(credentialId) {
  try {
    const res = await fetch(`${BACKEND_API_BASE}/api/agent/context?credential_id=${encodeURIComponent(credentialId || '')}`);
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

import { BACKEND_API_BASE } from '../../backendConfig.js';
import { buildAgentChatPayload } from '../payload/buildAgentChatPayload.js';

const API_BASE = BACKEND_API_BASE;

async function postJson(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    content: res.ok
      ? String(payload?.content || '').trim() || '(No response)'
      : `Error: ${payload?.detail || res.statusText}`,
  };
}

export function requestSimpleChat({ credentialId, messages }) {
  return postJson('/api/chat', {
    credential_id: String(credentialId || '').trim(),
    messages: Array.isArray(messages) ? messages : [],
  });
}

export function requestAgentChat({ credentialId, messages, workflowSnapshot = null, nodeInspection = null } = {}) {
  return postJson(
    '/api/agent/chat',
    buildAgentChatPayload({
      credentialId,
      messages,
      workflowSnapshot,
      nodeInspection,
    }),
  );
}

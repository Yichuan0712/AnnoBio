import { BACKEND_API_BASE } from '../../backendConfig.js';
import { buildAgentChatPayload, serializeAgentObservations } from '../payload/buildAgentChatPayload.js';

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
    payload,
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

export function requestAgentChat({
  credentialId,
  messages,
  workflowSnapshot = null,
  observations = [],
  nodeInspection = null,
  agentTrace = [],
} = {}) {
  return postJson(
    '/api/agent/chat',
    buildAgentChatPayload({
      credentialId,
      messages,
      workflowSnapshot,
      observations,
      nodeInspection,
      agentTrace,
    }),
  );
}

export async function requestAgentPlan({
  credentialId,
  messages,
  workflowSnapshot = null,
  observations = [],
  availableSkills = [],
  loopSignals = [],
  roundIndex = 1,
} = {}) {
  const result = await postJson('/api/agent/plan', {
    credential_id: String(credentialId || '').trim(),
    messages: Array.isArray(messages) ? messages : [],
    workflow_snapshot: workflowSnapshot && typeof workflowSnapshot === 'object' ? workflowSnapshot : null,
    observations: serializeAgentObservations(observations),
    available_skills: Array.isArray(availableSkills) ? availableSkills : [],
    loop_signals: Array.isArray(loopSignals) ? loopSignals : [],
    round_index: Number.isFinite(Number(roundIndex)) ? Math.max(1, Math.floor(Number(roundIndex))) : 1,
  });
  return {
    ...result,
    plan: result.ok && result.payload && typeof result.payload === 'object'
      ? result.payload
      : { done: false, plan_summary: '', expected_progress: '', skill_calls: [] },
  };
}

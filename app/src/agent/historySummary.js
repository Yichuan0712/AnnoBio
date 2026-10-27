/**
 * Condenses the start of a long Agent conversation into a summary the model gets instead of those
 * messages (agentLoop.js, historyBudget.js's planHistory). The summary is stored on the
 * conversation as {text, covered} and extended, never rebuilt, as the conversation grows: each new
 * summary folds the previous one in. The stored messages stay; only what the model sees changes.
 */
import { BACKEND_API_BASE } from '../backendConfig.js';

// The part being condensed is exactly what no longer fits, so its transcript is capped: long tool
// results mostly hold data rows the summary should not repeat anyway.
const TEXT_CHARS = 4000;
const TOOL_ARGUMENT_CHARS = 300;
const TOOL_RESULT_CHARS = 1200;
const TRANSCRIPT_CHARS = 60000;

function clip(text, limit) {
  const value = String(text || '');
  return value.length <= limit ? value : `${value.slice(0, limit)} [... ${value.length - limit} more characters]`;
}

function transcript(messages) {
  const lines = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const attached = (message.attachments || []).map((a) => `${a.id} ${a.name}`).join(', ');
      lines.push(`User: ${clip(message.content, TEXT_CHARS)}${attached ? ` [attached: ${attached}]` : ''}`);
    }
    else if (message.role === 'tool') lines.push(`Result of ${message.name || 'tool'}: ${clip(message.content, TOOL_RESULT_CHARS)}`);
    else {
      if (String(message.content || '').trim()) lines.push(`Agent: ${clip(message.content, TEXT_CHARS)}`);
      for (const call of message.toolCalls || []) lines.push(`Agent called ${call.name}: ${clip(call.arguments, TOOL_ARGUMENT_CHARS)}`);
    }
  }
  const text = lines.join('\n\n');
  if (text.length <= TRANSCRIPT_CHARS) return text;
  // Keep the opening (where goals are usually stated) and the latest part.
  const head = Math.floor(TRANSCRIPT_CHARS * 0.4);
  return `${text.slice(0, head)}\n\n[... ${text.length - TRANSCRIPT_CHARS} characters omitted ...]\n\n${text.slice(-(TRANSCRIPT_CHARS - head))}`;
}

function buildPrompt(previousSummary, messages) {
  return `You are condensing the start of a conversation between a user and the AnnoBio Agent, an assistant that builds LLM annotation pipelines on a visual canvas, so the Agent can continue without the original messages.

Write a summary of at most 400 words, in the language the user writes in, as three short plain-text parts:
Goal: what the user wants overall, with any preferences or constraints they stated.
Done: what was built, changed, run or decided, naming nodes by their titles and giving key results such as metrics, row counts and errors.
Open: questions still unanswered, proposals not yet applied, and what the Agent was about to do next.

Keep exact names, numbers and instructions the user gave. Leave out greetings, repetition and raw data rows. Do not add anything that is not in the conversation.
${previousSummary ? `\nSummary of the conversation before this part (fold it in):\n${previousSummary}\n` : ''}
Conversation:
${transcript(messages)}`;
}

/**
 * The new summary text, covering `previousSummary` and then `messages`; '' when the model call
 * fails, in which case the caller falls back to dropping those messages.
 */
export async function summarizeHistory({ credentialId, previousSummary = '', messages, signal }) {
  try {
    const res = await fetch(`${BACKEND_API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credential_id: credentialId,
        messages: [{ role: 'user', content: buildPrompt(previousSummary, messages) }],
      }),
      signal,
    });
    const payload = await res.json().catch(() => ({}));
    return res.ok ? String(payload?.content || '').trim() : '';
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.error('Summarize Agent history:', err);
    return '';
  }
}

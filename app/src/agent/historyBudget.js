/**
 * Keeps the history sent to the Agent model within what its context window leaves room for
 * (agentLoop.js). Tool results are
 * what fill a context window: one read_rows can return tens of thousands of characters, and every
 * earlier result is resent on each call. Over budget, large results from earlier turns become a
 * one-line note first, since the model can call the tool again; only if that is not enough are the
 * oldest turns dropped. The stored conversation is never changed, only what is sent.
 */

// Used when the backend can't say (GET /api/agent/context): its own fallback context window.
const FALLBACK_CONTEXT = { context_tokens: 32000, reply_tokens: 8192, system_prompt_tokens: 2000 };
// Headroom for estimateTokens being approximate.
const ESTIMATE_MARGIN = 0.9;
// Never squeeze the history below this, even for a tiny context window.
const MIN_HISTORY_TOKENS = 4000;
// Results at or below this size are cheap to keep, and often a short answer the model still needs.
const OMITTABLE_RESULT_CHARS = 1000;
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Rough token count that errs high: ~4 characters per token for ASCII, 1 per other character (CJK). */
export function estimateTokens(text) {
  const value = String(text || '');
  let nonAscii = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 127) nonAscii += 1;
  }
  return Math.ceil((value.length - nonAscii) / 4) + nonAscii;
}

/**
 * Tokens left for the chat history in one request: the model's context window (Settings → Agent
 * defaults, else what the model registries report) less the reply reserve, the system prompt, the
 * workspace summary and the tool definitions, with headroom for estimation error.
 * @param {object|null} context GET /api/agent/context's response
 */
export function historyTokenBudget(context, { workspaceSummary = '', tools = [] } = {}) {
  const { context_tokens: contextTokens, reply_tokens: reply, system_prompt_tokens: systemPrompt } = context || FALLBACK_CONTEXT;
  const fixed = reply + systemPrompt + estimateTokens(workspaceSummary) + estimateTokens(JSON.stringify(tools));
  return Math.max(MIN_HISTORY_TOKENS, Math.floor(contextTokens * ESTIMATE_MARGIN - fixed));
}

function messageTokens(message) {
  let tokens = estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  for (const call of message.toolCalls || []) tokens += estimateTokens(call.name) + estimateTokens(call.arguments);
  for (const attachment of message.attachments || []) tokens += estimateTokens(attachment.preview);
  return tokens;
}

/** An earlier user message with its attachment previews cut to a note: read_attachment reads them again. */
function withoutLargePreviews(message) {
  if (!(message.attachments || []).some((a) => String(a.preview || '').length > OMITTABLE_RESULT_CHARS)) return null;
  return {
    ...message,
    attachments: message.attachments.map((a) => (String(a.preview || '').length > OMITTABLE_RESULT_CHARS
      ? { ...a, preview: JSON.stringify({ attachment: a.id, name: a.name, kind: a.kind, note: 'Preview omitted to keep the conversation within the model\'s context. Call read_attachment if you need it.' }) }
      : a)),
  };
}

/**
 * The messages to send, within `budget` tokens (historyTokenBudget). Messages are in agentLoop.js's
 * stored shape. The current turn (from the last user message on) is always sent whole; dropping cuts
 * at a user message so no tool result loses the call it answers.
 */
export function fitHistory(messages, budget) {
  const tokens = messages.map(messageTokens);
  let total = tokens.reduce((sum, value) => sum + value, 0);
  if (total <= budget) return messages;

  let currentTurn = messages.length - 1;
  while (currentTurn > 0 && messages[currentTurn].role !== 'user') currentTurn -= 1;

  const fitted = messages.slice();
  for (let i = 0; i < currentTurn && total > budget; i += 1) {
    const message = fitted[i];
    const length = String(message.content || '').length;
    if (message.role === 'user') {
      const shortened = withoutLargePreviews(message);
      if (!shortened) continue;
      fitted[i] = shortened;
    } else {
      if (message.role !== 'tool' || length <= OMITTABLE_RESULT_CHARS) continue;
      fitted[i] = {
        ...message,
        content: `[Earlier ${message.name || 'tool'} result (${length} characters) omitted to keep the conversation within the model's context. Call the tool again if you need it.]`,
      };
    }
    const shrunk = messageTokens(fitted[i]);
    total -= tokens[i] - shrunk;
    tokens[i] = shrunk;
  }

  let start = 0;
  while (total > budget && start < currentTurn) {
    let next = start + 1;
    while (next < currentTurn && fitted[next].role !== 'user') next += 1;
    for (let i = start; i < next; i += 1) total -= tokens[i];
    start = next;
  }
  return start ? fitted.slice(start) : fitted;
}

/**
 * What to send given the conversation's summary so far (historySummary.js), which replaces its
 * first `summary.covered` messages. Returns the messages to send, the summary text, and how many
 * further messages would have to be dropped (`dropped`, ending at index `cut`): the Agent loop
 * summarizes those instead of losing them.
 * @param {{text: string, covered: number}|null} summary
 */
export function planHistory(messages, budget, summary = null) {
  const start = summary?.text ? summary.covered : 0;
  const recent = messages.slice(start);
  const summaryTokens = summary?.text ? estimateTokens(summary.text) + MESSAGE_OVERHEAD_TOKENS : 0;
  const fitted = fitHistory(recent, Math.max(MIN_HISTORY_TOKENS, budget - summaryTokens));
  const dropped = recent.length - fitted.length;
  return { messages: fitted, summaryText: summary?.text || '', dropped, cut: start + dropped };
}

// Meta's Responses API labels assistant text by its place in the turn:
// `phase: "commentary"` for a preamble written before a tool call, no phase for
// a final answer. A replayed assistant message without a phase is read as a
// finished turn (dev.meta.ai/docs/protocols/responses, "Message phase").
//
// Clients on another wire format carry no phase at all — Claude Code's
// Anthropic messages, Chat history — so every replayed "I'll check X first"
// reaches Meta as a turn that ended right there. Deep in a session the model
// copies that pattern: it announces the next step and stops without a tool
// call. Measured on 4 real stall points from a Claude Code transcript (8
// samples each, muse-spark-1.3-contributor): 16/32 replies stopped without a
// tool call as sent, 10/64 with commentary restored.
//
// Only commentary is inferred. An assistant message whose run ends in a tool
// call is unambiguous; anything else keeps no phase, which Meta already treats
// as a final answer. A phase the client sent is never overwritten.
import { ROLE, RESPONSES_ITEM } from "../schema/index.js";

const PHASE_COMMENTARY = "commentary";
const TOOL_CALL_ITEMS = new Set([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL]);

// Some clients send role-based items without `type` (see the Responses request translator).
function isAssistantMessage(item) {
  return item?.role === ROLE.ASSISTANT && (item.type === RESPONSES_ITEM.MESSAGE || item.type === undefined);
}

/**
 * Label replayed preambles with phase "commentary" on a Responses body.
 * Copy-on-write: labelled items are replaced, never mutated, because the
 * caller's items are reused across retries and account fallback.
 * @param {object} body - Responses request body; input[] is replaced when anything is labelled
 * @returns {object} body
 */
export function labelCommentaryPhase(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return body;

  let labelled = null;
  // Walk backwards so each assistant run knows what ends it. Reasoning items
  // sit inside the run (reasoning → message → function_call), so they are
  // skipped rather than treated as the end.
  let runEndsInToolCall = false;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (isAssistantMessage(item)) {
      if (runEndsInToolCall && !item.phase) {
        labelled ??= input.slice();
        labelled[i] = { ...item, phase: PHASE_COMMENTARY };
      }
      continue;
    }
    if (item?.type === RESPONSES_ITEM.REASONING) continue;
    runEndsInToolCall = TOOL_CALL_ITEMS.has(item?.type);
  }

  if (labelled) body.input = labelled;
  return body;
}

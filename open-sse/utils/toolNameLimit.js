/**
 * Shorten tool names that exceed an upstream's limit, and restore them on the
 * way back.
 *
 * Some upstreams reject the whole request when one tool name is too long:
 *   Meta (muse) → HTTP 400 `name must be at most 64 characters, got 74`
 * Clients build MCP names as `mcp__<server>__<tool>`, so one long MCP tool
 * breaks every model on that provider — the request fails before the model is
 * even chosen.
 *
 * Renaming is deterministic: the same input always produces the same short
 * name, so the response-side map built from one request also matches retries.
 * The suffix is a hash of the FULL original name, which keeps distinct long
 * names from colliding after truncation.
 *
 * Truncation happens on the prefix (not the tail) because MCP names carry the
 * server and tool identity there: `mcp__aiven__aiven_vcs_integration_repository…`
 * stays recognisable, whereas cutting to the tail would leave only boilerplate.
 */
import crypto from "node:crypto";
import { ROLE, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/index.js";

/** Upstreams commonly cap tool names at 64; keep a little headroom for the hash. */
const HASH_LEN = 8;
const SEPARATOR = "_";

/** Responses history items that carry a client tool name. */
const HISTORY_CALL_ITEMS = new Set([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL]);

/** Deterministic 8-hex-char digest of the original name. */
function shortHash(name) {
  return crypto.createHash("sha1").update(name).digest("hex").slice(0, HASH_LEN);
}

/**
 * Build a short replacement that is guaranteed to fit `maxLen`.
 * Returns null when no change is needed.
 */
export function shortenToolName(name, maxLen) {
  if (typeof name !== "string" || !name) return null;
  if (!Number.isFinite(maxLen) || maxLen <= 0) return null;
  if (name.length <= maxLen) return null;

  const suffix = SEPARATOR + shortHash(name);
  const keep = Math.max(1, maxLen - suffix.length);
  return name.slice(0, keep) + suffix;
}

/**
 * Rename every over-long tool name in a request body in place.
 *
 * Returns a Map of `shortName → originalName` for the response side, or null
 * when nothing changed. Names are renamed in the declarations (`tools[]`), in
 * `tool_choice`, and in the replayed history: once a long-named tool has been
 * called, the client resends that call with its own (long) spelling, and Meta
 * validates history names too — measured 400 `name must be at most 64
 * characters, got 74` on the turn after the first call.
 *
 * @param {object} body - request body (mutated)
 * @param {number} maxLen - upstream limit
 * @returns {Map<string,string>|null}
 */
export function shortenToolNamesInBody(body, maxLen) {
  if (!body || typeof body !== "object") return null;
  if (!Number.isFinite(maxLen) || maxLen <= 0) return null;

  const map = new Map();
  const rename = (name) => {
    const short = shortenToolName(name, maxLen);
    if (!short) return name;
    map.set(short, name);
    return short;
  };

  // OpenAI / Anthropic-in-OpenAI-shape: tools[].function.name
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const fn = tool?.function;
      if (fn && typeof fn.name === "string") {
        fn.name = rename(fn.name);
      }
      // Anthropic-native shape carries the name one level up.
      if (!fn && typeof tool?.name === "string") {
        tool.name = rename(tool.name);
      }
    }
  }

  // A pinned tool must keep resolving after the rename.
  const choice = body.tool_choice;
  if (choice && typeof choice === "object") {
    if (typeof choice.name === "string") choice.name = rename(choice.name);
    if (typeof choice.function?.name === "string") choice.function.name = rename(choice.function.name);
  }

  // Replayed calls. The rename is deterministic, so history and declarations
  // land on the same short name. History items may be the caller's objects,
  // reused across retries, so a renamed item is replaced rather than mutated.
  // Responses: input[] function_call / custom_tool_call items.
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) => {
      if (!HISTORY_CALL_ITEMS.has(item?.type) || typeof item.name !== "string") return item;
      const name = rename(item.name);
      return name === item.name ? item : { ...item, name };
    });
  }
  // Chat: assistant tool_calls[].function.name. Anthropic: tool_use blocks.
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (msg?.role !== ROLE.ASSISTANT) return msg;
      let next = msg;
      if (Array.isArray(msg.tool_calls)) {
        const calls = msg.tool_calls.map((call) => {
          const fn = call?.function;
          if (typeof fn?.name !== "string") return call;
          const name = rename(fn.name);
          return name === fn.name ? call : { ...call, function: { ...fn, name } };
        });
        if (calls.some((call, i) => call !== msg.tool_calls[i])) next = { ...next, tool_calls: calls };
      }
      if (Array.isArray(msg.content)) {
        const content = msg.content.map((block) => {
          if (block?.type !== CLAUDE_BLOCK.TOOL_USE || typeof block.name !== "string") return block;
          const name = rename(block.name);
          return name === block.name ? block : { ...block, name };
        });
        if (content.some((block, i) => block !== msg.content[i])) next = { ...next, content };
      }
      return next;
    });
  }

  return map.size > 0 ? map : null;
}

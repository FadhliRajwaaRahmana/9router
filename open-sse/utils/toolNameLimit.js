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

/** Upstreams commonly cap tool names at 64; keep a little headroom for the hash. */
const HASH_LEN = 8;
const SEPARATOR = "_";

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
 * Rename every over-long tool in an OpenAI-shaped `tools[]` array in place.
 *
 * Returns a Map of `shortName → originalName` for the response side, or null
 * when nothing changed. Tool names appear in exactly one place in the request
 * (the `function.name` field); tool_choice names are renamed too so a pinned
 * tool still resolves.
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

  return map.size > 0 ? map : null;
}

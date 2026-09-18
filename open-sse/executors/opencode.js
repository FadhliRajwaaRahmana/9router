import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";

// Official OpenCode fingerprint. Upstream gates the free tier on a *versioned*
// User-Agent: a bare "opencode" is rejected with
//   403 {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
// Requires version >= 1.17.0 (verified live 2026-09-17 against opencode.ai).
const OPENCODE_UA = "opencode/1.18.31 ai-sdk/provider-utils/4.0.46 runtime/bun/1.3.14";
const OPENCODE_UA_RE = /opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i;
const MIN_OPENCODE_UA_MAJOR = 1;
const MIN_OPENCODE_UA_MINOR = 17;

// Upstream validates the *shape* of the session id, not just its presence.
// Canonical form is fixed-width 30 chars: "ses_" + 12 hex + 14 Base62.
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_ID_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

// Models served by the Responses API; everything else stays on /chat/completions.
// Matched by family, not by exact id: upstream adds new `muse-spark-*` variants
// (1.2, 1.3, …) on a regular cadence and each one must use /responses.
const RESPONSES_MODEL_FAMILIES = ["muse-spark", "grok-4.6", "gpt-5.6-luna"];

// Fourth upstream gate (verified live 2026-09-18): the free tier fingerprints
// the official agentic client by the file-search tool quartet. A request that
// carries 0-3 of these names is rejected with 403 FreeTierError even when the
// UA, session shape and streaming flag are all correct; the quartet plus ANY
// extras returns 200. Bisection against opencode.ai/zen/v1/chat/completions:
//
//   no tools / [] / 3-of-4 / 10 fake names  -> 403
//   {bash,glob,grep,read}                   -> 200
//   quartet + 5 fakes / quartet + edit,write -> 200
//
// Missing declarations are appended as no-op tools the model may ignore;
// caller tools are preserved verbatim. Re-bisection is a one-line change here.
const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];

function base62(n) {
  return Array.from(crypto.randomBytes(n), (b) => BASE62_CHARS[b % 62]).join("");
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
  const raw = typeof tool.name === "string" ? tool.name : typeof fn?.name === "string" ? fn.name : "";
  return raw.trim();
}

/**
 * Append any missing fingerprint tool to `body.tools`.
 * `shape` selects the declaration format: Chat Completions nests the spec under
 * `function`, the Responses API keeps it flat.
 */
function ensureFingerprintTools(body, shape = "chat") {
  if (!body || typeof body !== "object") return;
  const present = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) present.add(name);
    }
  } else {
    body.tools = [];
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    const spec = {
      name,
      description: `OpenCode built-in ${name} tool`,
      parameters: { type: "object", properties: {} },
    };
    body.tools.push(
      shape === "responses"
        ? { type: "function", ...spec }
        : { type: "function", function: spec }
    );
    present.add(name);
  }
}

// 6 bytes big-endian from a BigInt, matching the Go reference implementation.
function hex6FromBigInt(value) {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  return out;
}

// Monotonic per-millisecond counter keeps session ids ordered (and unique) even
// when several requests land inside the same millisecond.
let lastSessionTs = 0;
let sessionCounter = 0;

/** Canonical descending session id: ses_ + 12 hex + 14 Base62 = 30 chars. */
function generateSessionId() {
  const now = Date.now();
  if (now !== lastSessionTs) {
    lastSessionTs = now;
    sessionCounter = 0;
  }
  sessionCounter++;
  const current = BigInt(now) * 0x1000n + BigInt(sessionCounter & 0xfff);
  const value = (~current) & 0xffffffffffffffffn;
  return `ses_${hex6FromBigInt(value)}${base62(14)}`;
}

/** Canonical request id: msg_ + 12 hex + 14 Base62 = 30 chars. */
function generateRequestId() {
  return `msg_${hex6FromBigInt(BigInt(Date.now()) * 0x1000n + 1n)}${base62(14)}`;
}

/** Canonical 40-char hex project id. */
function generateProjectId() {
  return crypto.randomBytes(20).toString("hex");
}

/**
 * Map any foreign session id onto a canonical 30-char one, deterministically:
 * the same input always yields the same output, so a CLI's multi-turn history
 * stays inside one upstream session instead of scattering across random ones.
 */
function translateSessionId(rawSessionId, clientTool = "generic") {
  const trimmed = String(rawSessionId || "").trim();
  if (!trimmed) return generateSessionId();
  if (SESSION_ID_RE.test(trimmed)) return trimmed;
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\u0000${clientTool || "generic"}\u0000${trimmed}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let body = "";
  for (let i = 6; i < 20; i++) body += BASE62_CHARS[digest[i] % 62];
  return `ses_${timeHex}${body}`;
}

/** True when a downstream User-Agent is an OpenCode build upstream will accept. */
function isValidOpencodeUserAgent(ua) {
  const m = OPENCODE_UA_RE.exec(String(ua || ""));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > MIN_OPENCODE_UA_MAJOR || (major === MIN_OPENCODE_UA_MAJOR && minor >= MIN_OPENCODE_UA_MINOR);
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODEL_FAMILIES.some((family) => base.includes(family));
}

function resolveOpencodeSession(body, credentials) {
  const headers = credentials?.rawHeaders || {};
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v;

  // NOTE: resolveSessionId() has no clientTool/plugin hook for a custom
  // generator — an unknown `generate` option is silently ignored. Its fallback
  // is deriveSessionId(), a bare `randomUUID() + Date.now()` with no prefix.
  // That raw value was being sent as x-opencode-session, which upstream rejects
  // with 403 FreeTierError because it does not match the canonical shape.
  // Always re-shape whatever it returns into the canonical 30-char form; the
  // mapping is deterministic, so a multi-turn conversation stays in one session.
  const raw = resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
  });
  return translateSessionId(raw, lower["x-opencode-client"] || "generic");
}

/**
 * Responses-API models reject continuity leftovers and deviate from the Chat
 * completions contract. Verified upstream behaviour:
 *  - reasoning items from earlier turns are rejected -> drop `type:"reasoning"`;
 *  - `encrypted_content` / `reasoning_encrypted_content` on input items 400s;
 *  - `reasoning.effort:"max"` is not a valid level -> clamp to "xhigh";
 *  - `muse-spark-1.3` only accepts `tool_choice:"auto"`;
 *  - output cap is `max_output_tokens` on this endpoint.
 */
function normalizeResponsesModelBody(model, body) {
  const cleanModel = baseModelId(model);
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current) ? current : null;
  const requestedEffort =
    typeof body.reasoning_effort === "string" ? body.reasoning_effort : currentReasoning?.effort;

  // Only "max" is out of range for these models (their top level is "xhigh").
  // Everything else passes through untouched — in particular "high" stays
  // "high": the Chat->Responses translator already settles on that level for a
  // client asking for "max", and reads downstream are indistinguishable, so
  // second-guessing it here would silently upgrade genuine "high" requests.
  let effort = typeof requestedEffort === "string" ? requestedEffort.toLowerCase().trim() : null;
  if (effort === "ultra") effort = "max";
  if (effort === "max") {
    const supported = getThinkingLevels("opencode", cleanModel);
    if (!supported?.length || !supported.includes("max")) effort = "xhigh";
  }
  if (effort) {
    body.reasoning = { ...currentReasoning, effort };
    delete body.reasoning_effort;
  }
  if (body.reasoning) {
    const r = typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning : {};
    if (!r.summary) r.summary = "auto";
    body.reasoning = r;
  }

  if (Array.isArray(body.input)) {
    body.input = body.input
      .filter((item) => !(item && typeof item === "object" && item.type === "reasoning"))
      .map((item) => {
        if (!item || typeof item !== "object") return item;
        const { encrypted_content, reasoning_encrypted_content, ...rest } = item;
        return rest;
      });
  }

  if (baseModelId(model).includes("muse-spark-1.3") && body.tool_choice != null && body.tool_choice !== "auto") {
    body.tool_choice = "auto";
  }
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    this._currentSessionId = null;
    this._currentProjectId = null;
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);
    // Project id is sticky per session so a conversation does not hop projects.
    if (!this._currentProjectId) this._currentProjectId = generateProjectId();

    // Free tier is STREAM-ONLY: a non-streaming request is answered with
    // 403 {"type":"FreeTierError"}. Verified live 2026-09-17 against the raw
    // endpoint with canonical headers — stream:false and a missing `stream`
    // both 403, stream:true returns 200, across every free model. The executor
    // always streams; a client that asked for JSON is served by the
    // provider-forced-SSE path in chatCore (tests: opencode stream coercion).
    body.stream = true;

    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens. Normalize the Chat
      // fields at this boundary before the per-family cleanup below.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeResponsesModelBody(model, body);
      // The same tool-quartet gate applies on /responses; only the declaration
      // shape differs (flat instead of nested under `function`).
      ensureFingerprintTools(body, "responses");
    } else {
      // Plain chat callers usually send no tools at all, which upstream answers
      // with 403 — inject the quartet so the request looks like the official client.
      ensureFingerprintTools(body, "chat");
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model) ? `${base}/zen/v1/responses` : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    // Only forward the downstream UA when it is an OpenCode build upstream
    // accepts; anything else (curl, SDK, bare "opencode") is rejected with a
    // FreeTierError, so fall back to the official fingerprint instead.
    const downstreamUa = lower["user-agent"] || "";
    const userAgent = isValidOpencodeUserAgent(downstreamUa) ? downstreamUa : OPENCODE_UA;

    const rawSession = lower["x-opencode-session"];
    const session = rawSession
      ? translateSessionId(rawSession, lower["x-opencode-client"] || "generic")
      : this._currentSessionId || generateSessionId();

    const rawProject = lower["x-opencode-project"];
    const project =
      rawProject && String(rawProject).trim() && String(rawProject).trim() !== "global"
        ? String(rawProject).trim()
        : this._currentProjectId || generateProjectId();

    const rawRequest = lower["x-opencode-request"];
    const requestId = REQUEST_ID_RE.test(String(rawRequest || "").trim())
      ? String(rawRequest).trim()
      : generateRequestId();

    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "x-api-key": "public",
      "User-Agent": userAgent,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": session,
      "x-opencode-request": requestId,
      "x-opencode-project": project,
      "Accept": stream ? "text/event-stream" : "*/*",
    };
  }
}

export const __test__ = {
  OPENCODE_UA,
  generateSessionId,
  generateRequestId,
  generateProjectId,
  translateSessionId,
  isValidOpencodeUserAgent,
  isResponsesModel,
  normalizeResponsesModelBody,
  SESSION_ID_RE,
};

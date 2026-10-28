/**
 * Probe-URL resolution for /api/providers/validate.
 *
 * Two bugs this module exists to prevent:
 *
 * 1. `format` gate — the route rejected anything that was not exactly
 *    `"openai"`, so every `openai-responses` provider (muse/Meta) answered
 *    400 "Provider validation not supported". The dashboard renders any
 *    non-2xx as "Invalid", so a valid Meta key looked rejected.
 *
 * 2. URL guessing — `{baseUrl}/models` string surgery turned muse's
 *    `https://api.meta.ai/v1/responses` into itself, a POST-only endpoint
 *    that answers GET with 405. The registry already declares the correct
 *    probe URL in `validateUrl` (muse -> https://api.meta.ai/v1/models).
 *
 * Keep this pure (no fetch, no env) so it stays trivially testable.
 */

/**
 * Pick the URL to GET for a cheap auth probe.
 *
 * @param {{baseUrl?: string, validateUrl?: string, format?: string} | null} cfg
 * @returns {string | null} absolute URL, or null when cfg has no baseUrl
 */
export function resolveValidateProbeUrl(cfg) {
  if (!cfg || !cfg.baseUrl) return null;

  // Registry-declared probe wins: it is the only value that knows about
  // endpoints whose real path is not derivable from the transport baseUrl.
  if (cfg.validateUrl) return cfg.validateUrl;

  const base = String(cfg.baseUrl);

  // Already a models endpoint.
  if (/\/models\/?$/.test(base)) return base.replace(/\/$/, "");

  // /chat/completions and /chatbot are the POST endpoints; their sibling probe is /models.
  if (/\/chat\/completions\/?$/.test(base)) return base.replace(/\/chat\/completions\/?$/, "/models");
  if (/\/chatbot\/?$/.test(base)) return base.replace(/\/chatbot\/?$/, "/models");

  // A POST-only Responses endpoint cannot be probed with GET; there is no
  // derivable sibling, so callers must fall back to a POST probe instead.
  if (/\/responses\/?$/.test(base)) return null;

  // Plain base like https://host/v1 -> append /models.
  return `${base.replace(/\/$/, "")}/models`;
}

/**
 * Whether the route can run any probe at all for this provider config.
 * Depends on having a baseUrl — not on the format string, which is what
 * locked `openai-responses` providers out.
 *
 * @param {{baseUrl?: string} | null | undefined} cfg
 * @returns {boolean}
 */
export function isValidationSupported(cfg) {
  return Boolean(cfg && cfg.baseUrl);
}

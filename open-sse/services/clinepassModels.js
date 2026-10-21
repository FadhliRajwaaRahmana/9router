import { buildClineHeaders } from "../shared/clineAuth.js";

const CLINEPASS_MODELS_ENDPOINT = "https://api.cline.bot/api/v1/models";
// Cline's free tier is published here, not in /api/v1/models: the catalog
// endpoint carries no `cline-free/*` ids at all. Cline's own SDK calls this
// feed unauthenticated (sdk/packages/core/src/services/llms/cline-recommended-models.ts),
// so no Authorization header is sent — adding one would only make the request
// fail on a header the endpoint ignores.
const CLINE_RECOMMENDED_MODELS_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const FETCH_TIMEOUT_MS = 5000;

/**
 * Build request headers for the ClinePass /models endpoint (Cline's upstream API).
 * Auth shape lives in shared/clineAuth: API keys ride plain Bearer, OAuth
 * access tokens carry the WorkOS `workos:` prefix.
 */
function buildModelListHeaders(token, isApiKey) {
  return buildClineHeaders(token, { Accept: "application/json" }, { isApiKey });
}

/**
 * Internal: fetch the raw model list from Cline's /models endpoint.
 * Returns the parsed array or null on any failure.
 */
async function fetchClineRawModels(credentials) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = buildModelListHeaders(token, isApiKey);

    const response = await fetch(CLINEPASS_MODELS_ENDPOINT, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = await response.json();
    const rawList = Array.isArray(json) ? json : json?.data;
    return Array.isArray(rawList) ? rawList : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch ClinePass live model catalog.
 *
 * Primary source is the recommended-models feed's `clinePass[]` tier: it is the
 * only place `cline-pass/*` ids still appear (the /models catalog dropped the
 * prefix). The /models catalog is still consulted first so any prefixed ids it
 * happens to carry win on a shared id.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClinepassModels(credentials) {
  const [rawList, tiers] = await Promise.all([
    fetchClineRawModels(credentials),
    fetchClineFeedTiers(),
  ]);

  const byId = new Map();
  for (const m of rawList || []) {
    if (typeof m?.id === "string" && m.id.startsWith("cline-pass/")) {
      byId.set(m.id, { id: m.id, name: m.name || m.id });
    }
  }
  for (const m of tiers?.clinePass || []) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }

  const models = Array.from(byId.values());
  return models.length ? { models } : null;
}

/**
 * Normalize one tier array from the recommended-models feed to `{id, name}`.
 * Drops entries without a usable id; returns [] for anything unexpected.
 */
function toModelEntries(tier) {
  if (!Array.isArray(tier)) return [];
  return tier
    .filter((m) => typeof m?.id === "string" && m.id.trim() !== "")
    .map((m) => ({ id: m.id, name: m.name || m.id }));
}

/**
 * Fetch Cline's recommended-models feed and return its tiers verbatim:
 * `{ free, clinePass, clineCloud, recommended }`, each normalized to
 * `{id, name}[]`. Returns null on any failure — every tier is additive, so a
 * dead feed must never take a caller's catalog down with it.
 *
 * The feed is the ONLY source that still carries `cline-pass/` ids: the
 * /api/v1/models catalog stopped tagging them (verified live 2026-10-18 —
 * 471 models, zero with the prefix), which is why prefix-filtering the
 * catalog yielded nothing.
 *
 * @returns {Promise<{free: object[], clinePass: object[], clineCloud: object[], recommended: object[]} | null>}
 */
async function fetchClineFeedTiers() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(CLINE_RECOMMENDED_MODELS_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = await response.json();
    if (!json || typeof json !== "object") return null;

    return {
      free: toModelEntries(json.free),
      clinePass: toModelEntries(json.clinePass),
      clineCloud: toModelEntries(json.clineCloud),
      recommended: toModelEntries(json.recommended),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch Cline live model catalog from Cline's /models endpoint.
 * Unlike resolveClinepassModels, this returns ALL models (including
 * free-tier models like z-ai/glm-5.3-flash) without the cline-pass/ prefix filter.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClineModels(credentials) {
  const rawList = await fetchClineRawModels(credentials);
  if (!rawList) return null;

  const models = rawList
    .filter((m) => typeof m?.id === "string" && m.id.trim() !== "")
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
    }));

  // The catalog lists no `cline-free/*` ids, so merge the feed's free tier in.
  // The `clinePass[]` subscription tier is deliberately NOT merged here: it is
  // billed against a separate ClinePass quota, so leaking those ids into the
  // plain `cline` provider would let a Cline login spend a subscription it does
  // not own. resolveClinepassModels() is the only consumer of that tier.
  // First writer wins on a shared id, keeping the catalog's entry.
  const tiers = await fetchClineFeedTiers();
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const m of tiers?.free || []) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  const merged = Array.from(byId.values());

  return merged.length ? { models: merged } : null;
}

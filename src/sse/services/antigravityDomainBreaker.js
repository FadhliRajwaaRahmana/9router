/**
 * Antigravity Domain Circuit Breaker — dynamic, no hard-coded domain list.
 *
 * When a GSuite seller deletes/suspends a whole domain (@gmilil.my.id,
 * @gmosel.com, @any-random-domain.my.id ...), Google returns the same
 * permanent 400/401/403 for EVERY account on that domain. Testing them one
 * by one costs N × timeout before the router reaches a healthy domain.
 *
 * This module auto-detects a domain that is dying and bulk-disables it so the
 * next getProviderCredentials() call skips it entirely (< 50 ms).
 *
 * Safe: gmail.com / googlemail.com are whitelisted — only per-account lock
 * ever applies to them. Threshold is adaptive so a single typo does not
 * nuke a healthy domain.
 *
 * PER-ACCOUNT VERIFICATION (added after a live false-positive):
 *
 * The ratio heuristic alone bulk-disabled 60 HEALTHY accounts. A seller had
 * delivered two batches on the same domain — 60 `hww*` accounts that Google
 * had deleted, and 60 `zvc*` accounts that were brand new and working. The
 * dead batch pushed the domain past the 30% threshold, so the breaker swept
 * the live batch with it. Verified afterwards by refreshing every token
 * directly against Google: 60/60 of the "disabled" accounts returned a valid
 * access_token.
 *
 * The lesson: a domain is a BILLING grouping, not a proxy for "this account
 * is dead". Sellers ship multiple batches on one domain, so a dead batch says
 * nothing about its neighbours.
 *
 * The ratio still earns its keep as a TRIGGER — it says "this domain is worth
 * checking". What it must not do is decide WHO is dead. That call now goes to
 * Google: each candidate's refresh token is exchanged, and only the ones that
 * actually fail are disabled. Live accounts keep working, and the breaker
 * still collapses a genuinely dead domain in one pass.
 */
import { getProviderConnections, updateProviderConnection, getSettings } from "@/lib/localDb";
import * as log from "../utils/logger.js";

// Never domain-break these public providers
const WHITELISTED_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// In-memory breaker state — survives per-process, cheap
const brokenDomains = new Set(); // domain -> already broken this process

export function getBrokenDomains() {
  return new Set(brokenDomains);
}

function extractDomain(email) {
  if (!email || typeof email !== "string") return "";
  const at = email.lastIndexOf("@");
  if (at === -1) return "";
  return email.slice(at + 1).trim().toLowerCase();
}

// 400/401/403 with auth text that proves the account is permanently dead,
// not a transient quota (429) or bad request body.
const PERMANENT_AUTH_PATTERNS = [
  /invalid_grant/i,
  /PERMISSION_DENIED/i,
  /UNAUTHENTICATED/i,
  /account.*(?:deleted|disabled|not found|suspended|does not exist)/i,
  /user.*(?:deleted|disabled|not found|suspended)/i,
  /Bad Request/i,
  /NO_CREDENTIALS/i,
  /401/i,
  /unauthorized/i,
];

export function isPermanentAntigravityAuthFailure(status, errorText) {
  if (status !== 400 && status !== 401 && status !== 403) return false;
  // HTTP 401 on Google Cloud Code generateContent endpoint is ALWAYS a permanent auth failure (revoked/deleted token)
  if (status === 401) return true;
  const text = String(errorText || "");
  if (!text) return status === 401;
  return PERMANENT_AUTH_PATTERNS.some((re) => re.test(text));
}

// How many accounts to verify concurrently. Token exchange is a small POST, so
// a modest fan-out keeps a 120-account domain under a few seconds without
// tripping Google's per-client rate limits.
const VERIFY_CONCURRENCY = 8;
// Per-account timeout. A refresh that takes longer than this is treated as
// "unknown", NOT "dead" — see the conservative rule in verifyAccounts.
const VERIFY_TIMEOUT_MS = 15_000;

/**
 * Ask Google whether each candidate account is actually dead.
 *
 * A refresh-token exchange is the cheapest possible probe: it spends no
 * inference quota and Google answers definitively — `invalid_grant` with
 * "Account has been deleted" means the account is gone, while a 200 with an
 * access_token means it is alive and simply had a bad moment.
 *
 * Returns a Map of connectionId -> true (dead) / false (alive). Accounts that
 * could not be reached are ABSENT from the map, and the caller must treat
 * absent as alive — disabling an account because our network hiccuped would
 * recreate the very bug this function exists to fix.
 *
 * @param {Array<{id: string, email: string, refreshToken?: string}>} accounts
 * @param {object|null} refreshFn - injectable for tests
 * @returns {Promise<Map<string, boolean>>}
 */
export async function verifyAccountsAlive(accounts, refreshFn = null) {
  const out = new Map();
  const queue = [...accounts];
  const doRefresh = refreshFn || (async (creds) => {
    const { refreshTokenByProvider } = await import("open-sse/services/tokenRefresh.js");
    return refreshTokenByProvider("antigravity", creds, null);
  });

  async function worker() {
    while (queue.length) {
      const acct = queue.shift();
      if (!acct?.refreshToken) continue; // no token to test — leave unjudged
      try {
        const refreshed = await Promise.race([
          doRefresh({ refreshToken: acct.refreshToken, email: acct.email }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("verify timeout")), VERIFY_TIMEOUT_MS)),
        ]);
        // A returned access_token proves the account is alive.
        out.set(acct.id, !refreshed?.accessToken);
      } catch (e) {
        // Definitive rejections only. Anything else (timeout, network, 5xx)
        // stays unjudged so the caller keeps the account.
        const msg = String(e?.message || e || "");
        if (/invalid_grant|account.*(?:deleted|disabled|suspended|not found)|unauthorized_client/i.test(msg)) {
          out.set(acct.id, true);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, worker));
  return out;
}

/**
 * Called right after a permanent 400/401/403 from the Antigravity executor.
 * Decides whether to bulk-disable an entire dynamic domain.
 *
 * Rules (all dynamic — no hard-coded domain list):
 *   - Whitelisted domains (gmail.com) → never
 *   - Domain with < 3 total accounts → needs 1 dead to trigger (small pools)
 *   - Domain with 3-15 accounts   → needs 2 dead in any window
 *   - Domain with >15 accounts    → needs 2 dead OR >= 30% dead
 *
 * The bulk write is fire-and-forget from the chat handler's point of view
 * (awaited here because the next account selection happens inside the same
 * while(true) loop and must see the isActive=false).
 *
 * @param {string} email - failed account email
 * @param {string} provider - must be "antigravity"
 * @param {{refreshFn?: Function}} [opts] - refreshFn injectable for tests
 * @returns {Promise<{ broken: boolean, domain: string, disabledCount: number }>}
 */
export async function maybeBreakAntigravityDomain(email, provider, opts = {}) {
  const domain = extractDomain(email);
  if (!domain) return { broken: false, domain: "", disabledCount: 0 };
  if (provider && provider !== "antigravity") return { broken: false, domain, disabledCount: 0 };
  if (WHITELISTED_DOMAINS.has(domain)) return { broken: false, domain, disabledCount: 0 };
  if (brokenDomains.has(domain)) return { broken: false, domain, disabledCount: 0 };

  // Use a snapshot of current active connections to compute counts
  let allForDomain;
  try {
    const connections = await getProviderConnections({ provider: "antigravity", isActive: true });
    allForDomain = connections.filter((c) => extractDomain(c.email) === domain);
  } catch {
    return { broken: false, domain, disabledCount: 0 };
  }

  const total = allForDomain.length;
  if (total === 0) return { broken: false, domain, disabledCount: 0 };

  // Re-read with inactive included to count how many are already disabled
  let allWithInactive;
  try {
    const raw = await getProviderConnections({ provider: "antigravity" });
    // getProviderConnections without isActive filter returns all — but we want only this domain
    allWithInactive = raw.filter((c) => extractDomain(c.email) === domain);
  } catch {
    allWithInactive = allForDomain;
  }

  const alreadyDisabled = allWithInactive.length - total;
  const deadCount = alreadyDisabled + 1; // +1 for the just-failed account (not yet written as disabled in this call)

  // Adaptive threshold — dynamic per domain size
  let threshold;
  if (total < 3) threshold = 1;
  else if (total <= 15) threshold = 2;
  else threshold = Math.max(2, Math.ceil(allWithInactive.length * 0.3));

  // Alternative ratio trigger for large domains (e.g. 40 accounts, 12 already dead = 30%)
  const ratioTriggered = allWithInactive.length >= 6 && deadCount / allWithInactive.length >= 0.35;

  const shouldBreak = deadCount >= threshold || ratioTriggered;
  if (!shouldBreak) {
    return { broken: false, domain, disabledCount: 0 };
  }

  // The threshold says "this domain is worth checking" — it does NOT say which
  // accounts are dead. Verify against Google before writing anything: a domain
  // is a billing grouping, and sellers ship multiple batches on one domain, so
  // a dead batch must not take its live neighbours down with it.
  let verdicts;
  try {
    verdicts = await verifyAccountsAlive(allForDomain, opts?.refreshFn || null);
  } catch {
    // Verification itself failed — do NOT disable on a guess.
    log.warn("AG_DOMAIN_BREAKER", `${domain} | verification failed; leaving ${total} accounts active`);
    return { broken: false, domain, disabledCount: 0 };
  }

  const dead = allForDomain.filter((c) => verdicts.get(c.id) === true);
  const alive = allForDomain.filter((c) => verdicts.get(c.id) === false);
  const unknown = allForDomain.filter((c) => !verdicts.has(c.id));

  if (!dead.length) {
    log.info("AG_DOMAIN_BREAKER", `${domain} | threshold hit but 0/${total} accounts failed verification — not disabling`);
    return { broken: false, domain, disabledCount: 0 };
  }

  // Only now do we treat the domain as broken — and only for the accounts
  // Google actually rejected.
  brokenDomains.add(domain);

  let disabledCount = 0;
  const reason = `domain_dead:${domain}`;
  const nowIso = new Date().toISOString();

  for (const c of dead) {
    try {
      const data = c.data && typeof c.data === "object" ? { ...c.data } : {};
      data.disabledReason = reason;
      data.disabledAt = nowIso;
      await updateProviderConnection(c.id, {
        isActive: false,
        data,
        testStatus: "unavailable",
        lastError: `Domain ${domain} auto-disabled: ${dead.length}/${total} accounts failed token verification`,
        errorCode: 400,
        lastErrorAt: nowIso,
      });
      disabledCount++;
    } catch {
      // best effort per account
    }
  }

  log.warn(
    "AG_DOMAIN_BREAKER",
    `${domain} | verified ${total} accounts: ${dead.length} dead, ${alive.length} alive (kept), ${unknown.length} unknown (kept) -> disabled ${disabledCount} (${reason})`
  );
  return { broken: true, domain, disabledCount, deadCount: dead.length, aliveCount: alive.length, unknownCount: unknown.length };
}

// Test-only: reset in-memory set
export function _resetBreakerForTest() {
  brokenDomains.clear();
}

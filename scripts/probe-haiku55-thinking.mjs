// Live probe: does Anthropic accept the normalized (adaptive) shape for haiku-5-5,
// and does it still reject the raw Claude Code shape? Reads the stored key from
// the local 9router sqlite, sends two tiny non-streaming requests.
import { DatabaseSync } from "node:sqlite";
import { normalizeClaudePassthrough } from "../open-sse/translator/formats/claude.js";

const db = new DatabaseSync(process.env.APPDATA + "/9router/db/data.sqlite", { readonly: true });
const key = JSON.parse(db.prepare("SELECT data FROM providerConnections WHERE provider='anthropic'").get().data).apiKey;

const base = () => ({
  model: "claude-haiku-5-5",
  max_tokens: 2048,
  thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" },
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
});

async function probe(label, body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`${label}: ${res.status} ${text.slice(0, 220).replace(/\s+/g, " ")}`);
}

const raw = base();
await probe("RAW (enabled+budget, seperti CC)", raw);

const fixed = base();
normalizeClaudePassthrough(fixed, "claude-haiku-5-5", "anthropic");
console.log("normalized ->", JSON.stringify({ thinking: fixed.thinking, output_config: fixed.output_config }));
await probe("NORMALIZED (adaptive+effort)", fixed);

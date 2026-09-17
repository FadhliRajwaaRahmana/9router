export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  // Free tier is stream-only: a non-streaming upstream call is answered with
  // 403 FreeTierError. chatCore reads this to call the provider with SSE and
  // then convert back to JSON for clients that asked for a non-streaming body.
  forceStream: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
  },
  models: [
    // The muse-spark family is served by /zen/v1/responses; the rest stay on
    // /chat/completions, so the format is declared per-model, not per-provider.
    // The executor keys off the "muse-spark" family (RESPONSES_MODEL_FAMILIES),
    // so new variants like 1.3 route correctly without an executor change.
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
  ],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};

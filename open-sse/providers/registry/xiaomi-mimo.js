import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "xiaomi-mimo",
  priority: 290,
  alias: "xiaomi-mimo",
  aliases: [
    "mimo",
  ],
  uiAlias: "mimo",
  display: {
    name: "Xiaomi MiMo",
    icon: "smart_toy",
    color: "#FF6900",
    textIcon: "XM",
    website: "https://xiaomimimo.com",
    notice: {
      apiKeyUrl: "https://platform.xiaomimimo.com/console/api-keys",
    },
  },
  category: "apikey",
  // Kunci bersifat per-cluster. MiMo Desktop mendeklarasikan lima region
  // (CN/SGP/AMS/RU/IN) — host dan sid mengikuti pola mimo-server-<kode> /
  // mimo<kode>. Region tak dikenal jatuh ke sgp.
  //
  // Sumber: upstream decolua/9router 910db749.
  regions: [
    { id: "cn", label: "China (中国大陆)" },
    { id: "sgp", label: "Singapore (新加坡)" },
    { id: "ams", label: "Europe · Amsterdam (欧洲)" },
    { id: "ru", label: "Russia (俄罗斯)" },
    { id: "in", label: "India (印度)" },
  ],
  defaultRegion: "sgp",
  serviceKinds: ["llm", "tts"],
  transport: {
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    validateUrl: "https://api.xiaomimimo.com/v1/models",
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    // Model dual-route v2.6: memakai kuota akun Desktop bila kredensialnya ada,
    // jika tidak jatuh ke cloud API (kunci sk-). Menggantikan id
    // mimo-x-*-preview yang sudah usang.
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", upstreamModelId: "xiaomi/mimo-v2.6-pro", supportedFormats: ["openai"] },
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", upstreamModelId: "xiaomi/mimo-v2.6-flash", supportedFormats: ["openai"] },
    { id: "mimo-v2.6-pro-ultraspeed", name: "MiMo V2.6 Pro UltraSpeed", upstreamModelId: "xiaomi/mimo-v2.6-pro-ultraspeed", supportedFormats: ["openai"] },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "mimo-v2.5", name: "MiMo V2.5" },
    { id: "mimo-v2-omni", name: "MiMo V2 Omni" },
    { id: "mimo-v2-flash", name: "MiMo V2 Flash" },
    { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", kind: "tts" },
  ],
  ttsConfig: {
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    authType: "apikey",
    authHeader: "bearer",
    format: "xiaomi-mimo-tts",
  },
};

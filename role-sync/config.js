const fs = require("node:fs");

const seconds = (name, fallback) => Number(process.env[name] ?? fallback) * 1000;
const port = Number(process.env.PORT ?? 8282);

module.exports = {
  zitadelUrl: process.env.ZITADEL_URL ?? "http://zitadel.localhost:8080",
  pat: fs.readFileSync(process.env.PAT_FILE ?? "/bootstrap/admin.pat", "utf8").trim(),
  opaUrls: (process.env.OPA_URLS ?? "http://opa:8181").split(","),
  stateDir: process.env.STATE_DIR ?? "/state",
  port,
  webhookUrl: process.env.WEBHOOK_URL ?? `http://role-sync:${port}/webhook`,
  pageSize: 1000,
  pollMs: seconds("POLL_INTERVAL_SECONDS", 5),
  overlapMs: seconds("EVENT_OVERLAP_SECONDS", 10),
  rebuildMs: seconds("FULL_REBUILD_SECONDS", 86400),
  staleMs: seconds("STALE_AFTER_SECONDS", 60),
};

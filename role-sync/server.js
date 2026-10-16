const http = require("node:http");
const { staleMs } = require("./config");
const log = require("./log");
const opa = require("./opa");
const blocks = require("./blocks");
const engine = require("./engine");
const { state } = require("./state");

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function health(res) {
  const age = Date.now() - state.lastEventReadAt;
  send(res, state.lastEventReadAt && age < staleMs ? 200 : 503, {
    last_event_read_seconds_ago: state.lastEventReadAt ? Math.round(age / 1000) : null,
    cursor: state.cursor === null ? null : new Date(state.cursor).toISOString(),
    last_rebuild: iso(state.lastRebuildAt),
    opa_in_sync: Object.fromEntries(opa.inSync),
    blocked: state.blocked,
  });
}

async function changeBlock(req, res, sub) {
  const reason = req.method === "PUT" ? ((await readBody(req)).reason ?? "") : null;
  const { entry, status } = await engine.serial(() => (reason === null ? blocks.unblock(sub) : blocks.block(sub, reason)));
  send(res, Object.values(status).every((s) => s === "applied") ? 200 : 202, { sub, block: entry, opa: status });
}

async function route(req, res) {
  const { pathname } = new URL(req.url, "http://role-sync");
  const [, resource, sub] = pathname.split("/").map(decodeURIComponent);

  if (req.method === "GET" && pathname === "/healthz") return health(res);
  if (req.method === "POST" && pathname === "/webhook") {
    engine.nudge();
    return send(res, 204);
  }
  if (resource === "blocks" && !sub && req.method === "GET") return send(res, 200, state.blocked);
  if (resource === "blocks" && sub && (req.method === "PUT" || req.method === "DELETE")) return changeBlock(req, res, sub);
  send(res, 404, { error: "not found" });
}

function listen(port, onListening) {
  return http
    .createServer((req, res) =>
      route(req, res).catch((err) => {
        log(`${req.method} ${req.url} failed: ${err.message}`);
        send(res, 500, { error: err.message });
      }),
    )
    .listen(port, onListening);
}

module.exports = { listen };

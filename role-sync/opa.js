const { opaUrls } = require("./config");
const log = require("./log");
const { countGrants } = require("./roles");

const inSync = new Map(opaUrls.map((url) => [url, false]));

const put = (path, body) => ({ method: "PUT", path, body });
const del = (path) => ({ method: "DELETE", path });

async function call(url, { method, path, body }) {
  const res = await fetch(`${url}/v1/data/${path.map(encodeURIComponent).join("/")}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (method === "DELETE" && res.status === 404) return null;
  if (!res.ok) throw new Error(`opa ${method} ${path.join("/")}: ${res.status} ${await res.text()}`);
  return method === "GET" ? res.json() : null;
}

async function apply(writes) {
  const status = {};
  await Promise.all(
    opaUrls.map(async (url) => {
      if (!inSync.get(url)) return (status[url] = "pending");
      try {
        for (const write of writes) await call(url, write);
        status[url] = "applied";
      } catch (err) {
        inSync.set(url, false);
        status[url] = "pending";
        log(`${url} out of sync, full push on next tick: ${err.message}`);
      }
    }),
  );
  return status;
}

async function reconcile({ epoch, roles, blocked }) {
  await Promise.all(
    opaUrls.map(async (url) => {
      try {
        const { result } = await call(url, { method: "GET", path: ["role_sync", "epoch"] });
        if (inSync.get(url) && result === epoch) return;
        await call(url, put(["blocked"], blocked));
        await call(url, put(["server_roles"], roles));
        await call(url, put(["role_sync"], { epoch }));
        inSync.set(url, true);
        log(`full push to ${url}: ${countGrants(roles)} user grants, ${Object.keys(blocked).length} blocks`);
      } catch (err) {
        if (inSync.get(url)) log(`${url} out of sync: ${err.message}`);
        inSync.set(url, false);
      }
    }),
  );
}

function markAllOutOfSync() {
  for (const url of opaUrls) inSync.set(url, false);
}

module.exports = { inSync, put, del, apply, reconcile, markAllOutOfSync };

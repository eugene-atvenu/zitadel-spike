const { overlapMs, pollMs, rebuildMs } = require("./config");
const log = require("./log");
const zitadel = require("./zitadel");
const opa = require("./opa");
const roles = require("./roles");
const blocks = require("./blocks");
const { state, saveRoles } = require("./state");

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function attempt(name, fn) {
  try {
    await fn();
  } catch (err) {
    log(`${name} failed: ${err.message}`);
  }
}

function rememberOwners(grants) {
  for (const grant of grants) state.grantOwners.set(grant.id, grant.userId);
}

async function rebuild() {
  const cursor = state.cursor ?? (await zitadel.latestGrantEventAt());
  const grants = await zitadel.searchGrants();
  rememberOwners(grants);
  const next = roles.groupActive(grants);

  const drift = roles.countDrift(state.roles, next);
  if (state.lastRebuildAt && drift) log(`DRIFT: full rebuild changed ${drift} user grants that events missed`);

  state.roles = next;
  state.cursor = cursor;
  state.lastRebuildAt = Date.now();
  saveRoles();
  opa.markAllOutOfSync();

  log(`full rebuild: ${roles.countGrants(next)} user grants across ${Object.keys(next).length} projects`);
  if (Object.keys(state.blocked).length) log(`active blocks: ${blocks.describeActive()}`);
}

async function fetchNewEvents() {
  const events = await zitadel.grantEventsSince(state.cursor - overlapMs);
  const fresh = new Map();
  for (const event of events) {
    const key = `${event.aggregate.id}:${event.sequence}`;
    if (!state.seen.has(key)) fresh.set(key, event);
  }
  return fresh;
}

async function affectedUsers(events) {
  const users = new Set();
  for (const event of events) {
    const grantId = event.aggregate.id;
    const userId = event.payload?.userId ?? state.grantOwners.get(grantId) ?? (await zitadel.grantOwner(grantId));
    state.grantOwners.set(grantId, userId);
    users.add(userId);
  }
  return users;
}

async function refreshUsers(users) {
  const changes = [];
  for (const userId of users) {
    const grants = await zitadel.userGrants(userId);
    rememberOwners(grants);
    changes.push(...roles.userChanges(state.roles, userId, grants));
  }
  for (const change of changes) roles.applyChange(state.roles, change);
  if (changes.length) {
    await opa.apply(
      changes.map(({ projectId, userId, roles: next }) =>
        next ? opa.put(["server_roles", projectId, userId], next) : opa.del(["server_roles", projectId, userId]),
      ),
    );
  }
  return changes;
}

function commitEvents(fresh) {
  for (const [key, event] of fresh) {
    const at = Date.parse(event.creationDate);
    state.seen.set(key, at);
    state.cursor = Math.max(state.cursor, at);
  }
  for (const [key, at] of state.seen) if (at < state.cursor - overlapMs) state.seen.delete(key);
  if (fresh.size) saveRoles();
}

async function readEvents() {
  const fresh = await fetchNewEvents();
  const users = await affectedUsers(fresh.values());
  const changes = await refreshUsers(users);
  commitEvents(fresh);
  if (changes.length) log(`${fresh.size} grant events, ${changes.length} role changes for ${users.size} users`);
  state.lastEventReadAt = Date.now();
}

async function registerWebhook() {
  const url = await zitadel.registerWebhook();
  state.webhookRegistered = true;
  log(`user grant webhook registered: ${url}`);
}

async function tick() {
  await attempt("opa sync", () => opa.reconcile(state));
  if (state.cursor === null || Date.now() - state.lastRebuildAt >= rebuildMs) await attempt("full rebuild", rebuild);
  if (state.cursor !== null) await attempt("event read", readEvents);
  if (!state.webhookRegistered) await attempt("webhook registration", registerWebhook);
}

let nudged = false;
function nudge() {
  if (nudged) return;
  nudged = true;
  serial(() => {
    nudged = false;
    return attempt("event read", readEvents);
  });
}

async function start() {
  await serial(tick);
  setTimeout(start, pollMs);
}

module.exports = { serial, nudge, start };

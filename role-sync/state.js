const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { stateDir } = require("./config");

const files = {
  roles: path.join(stateDir, "server_roles.json"),
  blocked: path.join(stateDir, "blocked.json"),
  cursor: path.join(stateDir, "cursor.json"),
};

const state = {
  epoch: crypto.randomUUID(),
  roles: {},
  blocked: {},
  cursor: null,
  lastRebuildAt: 0,
  lastEventReadAt: 0,
  webhookRegistered: false,
  seen: new Map(),
  grantOwners: new Map(),
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, JSON.stringify(value));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function load() {
  const saved = readJson(files.cursor, null);
  const savedRoles = readJson(files.roles, null);
  if (saved && savedRoles) {
    state.roles = savedRoles.server_roles;
    state.cursor = Date.parse(saved.cursor);
    state.lastRebuildAt = saved.lastRebuildAt;
  }
  state.blocked = readJson(files.blocked, { blocked: {} }).blocked;
  saveBlocked();
  return saved?.cursor ?? null;
}

function saveRoles() {
  writeJson(files.roles, { server_roles: state.roles });
  writeJson(files.cursor, { cursor: new Date(state.cursor).toISOString(), lastRebuildAt: state.lastRebuildAt });
}

function saveBlocked() {
  writeJson(files.blocked, { blocked: state.blocked });
}

module.exports = { state, load, saveRoles, saveBlocked };

const log = require("./log");
const opa = require("./opa");
const { state, saveBlocked } = require("./state");

function block(sub, reason) {
  const entry = { reason, blocked_at: new Date().toISOString() };
  state.blocked[sub] = entry;
  saveBlocked();
  log(`blocked ${sub}: ${reason}`);
  return opa.apply([opa.put(["blocked", sub], entry)]).then((status) => ({ entry, status }));
}

function unblock(sub) {
  delete state.blocked[sub];
  saveBlocked();
  log(`unblocked ${sub}`);
  return opa.apply([opa.del(["blocked", sub])]).then((status) => ({ entry: null, status }));
}

function describeActive() {
  return Object.entries(state.blocked)
    .map(([sub, entry]) => `${sub} since ${entry.blocked_at}`)
    .join(", ");
}

module.exports = { block, unblock, describeActive };

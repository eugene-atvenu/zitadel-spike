const { port, opaUrls } = require("./config");
const log = require("./log");
const roles = require("./roles");
const server = require("./server");
const engine = require("./engine");
const { state, load } = require("./state");

const resumedFrom = load();
if (resumedFrom) log(`resumed from ${resumedFrom} with ${roles.countGrants(state.roles)} user grants`);

server.listen(port, () => log(`listening on :${port}, pushing to ${opaUrls.join(", ")}`));
engine.start();

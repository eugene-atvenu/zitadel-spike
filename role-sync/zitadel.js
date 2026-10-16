const { zitadelUrl, pat, pageSize, webhookUrl } = require("./config");

async function call(apiPath, body, method = "POST") {
  const res = await fetch(zitadelUrl + apiPath, {
    method,
    headers: { authorization: `Bearer ${pat}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`zitadel ${apiPath}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function searchGrants(queries = []) {
  const grants = [];
  for (let offset = 0; ; offset += pageSize) {
    const { result = [] } = await call("/management/v1/users/grants/_search", {
      query: { offset: String(offset), limit: pageSize, asc: true },
      queries,
    });
    grants.push(...result);
    if (result.length < pageSize) return grants;
  }
}

function userGrants(userId) {
  return searchGrants([{ userIdQuery: { userId } }]);
}

function searchGrantEvents(filter) {
  return call("/admin/v1/events/_search", { aggregateTypes: ["usergrant"], ...filter });
}

async function grantEventsSince(sinceMs) {
  const all = [];
  for (let since = sinceMs; ; ) {
    const { events = [] } = await searchGrantEvents({
      asc: true,
      limit: pageSize,
      range: { since: new Date(since).toISOString() },
    });
    all.push(...events);
    if (events.length < pageSize) return all;
    const last = Date.parse(events.at(-1).creationDate);
    if (last <= since) throw new Error(`more than ${pageSize} grant events at ${events.at(-1).creationDate}`);
    since = last;
  }
}

async function latestGrantEventAt() {
  const { events = [] } = await searchGrantEvents({ asc: false, limit: 1 });
  return events.length ? Date.parse(events[0].creationDate) : 0;
}

async function grantOwner(grantId) {
  const { events = [] } = await searchGrantEvents({ asc: true, limit: 1, aggregateId: grantId });
  const userId = events[0]?.payload?.userId;
  if (!userId) throw new Error(`no user found for grant ${grantId}`);
  return userId;
}

async function registerWebhook() {
  const { targets = [] } = await call("/v2/actions/targets/search", {
    filters: [{ targetNameFilter: { targetName: "role-sync" } }],
  });
  const targetId =
    targets[0]?.id ??
    (await call("/v2/actions/targets", { name: "role-sync", endpoint: webhookUrl, timeout: "5s", restAsync: {} })).id;
  await call("/v2/actions/executions", { condition: { event: { group: "user.grant" } }, targets: [targetId] }, "PUT");
  return webhookUrl;
}

module.exports = { searchGrants, userGrants, grantEventsSince, latestGrantEventAt, grantOwner, registerWebhook };

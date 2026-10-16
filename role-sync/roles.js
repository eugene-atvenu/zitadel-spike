const sameRoles = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function groupActive(grants) {
  const grouped = {};
  for (const grant of grants) {
    if (grant.state !== "USER_GRANT_STATE_ACTIVE" || !grant.roleKeys?.length) continue;
    const users = (grouped[grant.projectId] ??= {});
    users[grant.userId] = [...new Set([...(users[grant.userId] ?? []), ...grant.roleKeys])].sort();
  }
  return grouped;
}

function countGrants(byProject) {
  return Object.values(byProject).reduce((sum, users) => sum + Object.keys(users).length, 0);
}

function countDrift(current, next) {
  let drift = 0;
  for (const projectId of new Set([...Object.keys(current), ...Object.keys(next)])) {
    const a = current[projectId] ?? {};
    const b = next[projectId] ?? {};
    for (const userId of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!sameRoles(a[userId], b[userId])) drift++;
    }
  }
  return drift;
}

function userChanges(roles, userId, grants) {
  const grouped = groupActive(grants);
  const changes = [];
  for (const projectId of new Set([...Object.keys(roles), ...Object.keys(grouped)])) {
    const next = grouped[projectId]?.[userId] ?? null;
    if (!sameRoles(roles[projectId]?.[userId] ?? null, next)) changes.push({ projectId, userId, roles: next });
  }
  return changes;
}

function applyChange(roles, { projectId, userId, roles: next }) {
  if (next) (roles[projectId] ??= {})[userId] = next;
  else delete roles[projectId]?.[userId];
}

module.exports = { groupActive, countGrants, countDrift, userChanges, applyChange };

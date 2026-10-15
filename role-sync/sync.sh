#!/bin/sh
set -u

apk add --no-cache curl jq >/dev/null

ZITADEL=http://zitadel:8080
OPA=http://opa:8181
PAT=$(cat /bootstrap/admin.pat)
INTERVAL=${SYNC_INTERVAL_SECONDS:-10}
PAGE_SIZE=100

fetch_grants() {
  offset=0
  all='[]'
  while :; do
    page=$(curl -fsS -X POST "$ZITADEL/management/v1/users/grants/_search" \
      -H "Host: zitadel.localhost:8080" \
      -H "Authorization: Bearer $PAT" \
      -H "Content-Type: application/json" \
      -d "{\"query\":{\"offset\":\"$offset\",\"limit\":$PAGE_SIZE,\"asc\":true}}") || return 1
    count=$(echo "$page" | jq '.result // [] | length')
    all=$(jq -n --argjson a "$all" --argjson p "$page" '$a + ($p.result // [])')
    offset=$((offset + count))
    total=$(echo "$page" | jq -r '.details.totalResult // "0" | tonumber')
    [ "$count" -lt "$PAGE_SIZE" ] || [ "$offset" -ge "$total" ] && break
  done
  echo "$all"
}

group_by_project() {
  jq 'reduce .[] as $g ({}; .[$g.projectId][$g.userId] += ($g.roleKeys // []))
      | map_values(map_values(unique))'
}

while :; do
  if roles=$(fetch_grants | group_by_project) && [ -n "$roles" ]; then
    if curl -fsS -X PUT "$OPA/v1/data/server_roles" \
      -H "Content-Type: application/json" -d "$roles" >/dev/null; then
      echo "role-sync: pushed $(echo "$roles" | jq '[.[] | length] | add // 0') user grants across $(echo "$roles" | jq 'length') projects"
    else
      echo "role-sync: OPA push failed, keeping previous data"
    fi
  else
    echo "role-sync: Zitadel fetch failed, keeping previous data"
  fi
  sleep "$INTERVAL"
done

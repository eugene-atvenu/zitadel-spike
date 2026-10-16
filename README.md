# APISIX + Zitadel + OPA demo

```
client ──► APISIX :9080 ──► openid-connect (JWT verified via Zitadel JWKS)
                        ──► opa (server roles from its own copy, sent upstream as X-Roles)
                        ──► node app :3000

Zitadel ──(user.grant webhook)──► role-sync ──(per-user changes)──► OPA data.server_roles
        ◄─(grant events since cursor, every 5s)─┘    └─(snapshot files, loaded on OPA boot)
```

Tokens carry identity and client roles only. Server roles live in Zitadel project `demo-api`, which has role assertion off, so they never appear in a token. `role-sync` keeps OPA's copy of every active user grant in the org, grouped by project. The policy maps the APISIX route to a project, looks up the caller's roles there, and APISIX forwards them to the app as `X-Roles`, replacing any client-supplied value.

| Service   | Port | Purpose |
|-----------|------|---------|
| zitadel   | 8080 | IdP (`http://zitadel.localhost:8080/ui/console`, `admin@demo.zitadel.localhost` / `Password1!`) |
| apisix    | 9080 | Gateway, standalone YAML config in `apisix/` |
| opa       | —    | Policy `opa/authz.rego`: blocked users are denied, `GET` needs a valid token, writes need the `writer` server role. Loads the route-to-project map from `generated/opa-data.json` and the role-sync snapshot files on boot |
| role-sync | 8282 | Keeps `data.server_roles` (`{projectId: {userId: [roles]}}`) and `data.blocked` in OPA. See [Role sync](#role-sync). Bound to `127.0.0.1` |
| app       | —    | Node HTTP server echoing the caller |
| mailpit   | 8025 | Catches all Zitadel email (signup codes, password resets). Inbox at http://localhost:8025 |
| bootstrap | —    | One-shot: creates project `demo-web` (client roles `beta-ui` and `editor`, role assertion on, both OIDC apps) and project `demo-api` (server role `writer`, role assertion off), machine users `reader` and `writer`, human users `alice` and `bob`. `writer` and `alice` get `writer`; `alice` and `bob` get `beta-ui`; `alice` also gets `editor`. Writes `generated/creds.env` and `generated/opa-data.json` |

## Run

```sh
docker compose up -d --wait
```

Then open the `bruno/` folder as a collection in [Bruno](https://www.usebruno.com), select the `local` environment, and run the collection. Credentials come from `generated/creds.env` via the `bruno/.env` symlink.

| Request | Expected |
|---|---|
| Get reader token / Get writer token | 200, stores the token in a runtime variable |
| GET no token | 401 |
| GET as reader | 200 |
| POST as reader | 403 `writer role required` |
| POST as writer | 200 |
| GET tampered token | 401 |
| Block writer | 200, writer is in the role-sync block list |
| POST as blocked writer | 403 `user blocked` |
| Unblock writer | 200 |
| POST as unblocked writer | 200 |

From the command line:

```sh
cd bruno && npx @usebruno/cli run --env local
```

## Role sync

`role-sync` ([role-sync/](role-sync/)) is the only writer to OPA's role and block data.

| File | Role |
|---|---|
| `index.js` | Loads state, starts the HTTP server and the sync loop |
| `engine.js` | Sync loop: OPA check, full rebuild, event read, webhook registration |
| `zitadel.js` | Zitadel API client: grants, grant events, webhook target |
| `opa.js` | OPA data API client and per-instance sync tracking |
| `roles.js` | Pure functions: group grants, diff a user, count drift |
| `state.js` | In-memory state and the snapshot files |
| `blocks.js` | Block list changes |
| `server.js` | HTTP routes: `/healthz`, `/webhook`, `/blocks` |

| Path | Trigger | What it does |
|---|---|---|
| Event read | Every `POLL_INTERVAL_SECONDS` (5) | Reads `usergrant` events from the Zitadel event API since the saved cursor, minus a 10s overlap. Refetches the active grants of each affected user and sends only the changed `server_roles/<project>/<user>` entries to OPA |
| Webhook | Zitadel Actions v2 `user.grant` event | Runs an event read immediately. Carries no data, so a missed webhook only delays a change until the next poll. role-sync registers the target itself on startup |
| Full rebuild | Startup without saved state, then every `FULL_REBUILD_SECONDS` (86400) | Rereads all grants. Logs `DRIFT` if the result differs from what the events produced |
| OPA check | Every poll | Compares an epoch in `data.role_sync` with its own. A restarted or failed OPA gets a full push |

Each change also rewrites the state volume: `server_roles.json` and `blocked.json`, which OPA loads on boot, and `cursor.json`, which role-sync resumes from after a restart.

`GET /healthz` returns 503 when the last successful event read is older than `STALE_AFTER_SECONDS` (60). The body shows the cursor, last rebuild, OPA sync state and active blocks.

### Blocking a user

The block list is for revoking access when Zitadel is unavailable. A block denies every request from that `sub`, and Zitadel syncs never remove it.

```sh
curl -X PUT localhost:8282/blocks/<userId> -d '{"reason":"lost device"}'
curl localhost:8282/blocks
curl -X DELETE localhost:8282/blocks/<userId>
```

The response is `200` once every OPA has the change, or `202` when an OPA is unreachable and will get it on the next full push. Each full rebuild logs active blocks. Remove a block after making the matching change in Zitadel.

## Browser login: option A vs option B

Sign in as `alice` (client `beta-ui` and `editor`, server `writer`) or `bob` (client `beta-ui` only), password `Password1!`. Use Chrome or Firefox; both resolve `zitadel.localhost` to your machine.

Accounts registered on the login page must enter an email code first; open the Mailpit inbox at http://localhost:8025 to get it. New accounts have no roles until granted in the console.

| | Option A: gateway login | Option B: SPA login |
|---|---|---|
| URL | http://localhost:9080/a/ | http://localhost:9080/b/ |
| Who runs OIDC | APISIX (`openid-connect`, `bearer_only: false`) | Browser JavaScript (`oidc-client-ts`) |
| Zitadel app type | Web, confidential (client secret in APISIX) | User Agent, public (PKCE only) |
| Browser holds | HttpOnly encrypted session cookie | Access token in `sessionStorage` |
| API calls | `/a/*` with the cookie | `/api/*` with `Authorization: Bearer` |
| App receives | `X-Access-Token`, `X-ID-Token`, `X-Userinfo` | `X-Access-Token` |
| Logout | `/a/logout` (APISIX ends the Zitadel session) | `signoutRedirect()` in the page |

Both paths go through the same OPA policy: GET is allowed for any signed-in user, POST needs the `writer` server role. The API reads roles only from `X-Roles`. The pages lock the POST button unless the token has the `editor` client role; a checkbox unlocks it so you can see the server reject the call. Page B reads client roles from its own token; page A reads them from `/a/me`, which returns the ID token claims APISIX passes in `X-ID-Token`.

Sequence diagrams: [docs/flow-option-a.mmd](docs/flow-option-a.mmd), [docs/flow-option-b.mmd](docs/flow-option-b.mmd).

## Get a token manually

```sh
. ./generated/creds.env
curl -s http://localhost:8080/oauth/v2/token -H "Host: zitadel.localhost:8080" \
  -u "$WRITER_CLIENT_ID:$WRITER_CLIENT_SECRET" -d grant_type=client_credentials \
  --data-urlencode "scope=openid urn:zitadel:iam:org:project:id:${API_PROJECT_ID}:aud"
```

## Reset

```sh
docker compose down -v && rm -rf generated
```

## Notes

- Zitadel's issuer is `http://zitadel.localhost:8080`. Containers reach it through the `zitadel.localhost` network alias, and the host reaches it on `localhost:8080` with that `Host` header.
- Server role changes reach OPA within about a second through the webhook, or one poll interval (5s) without it. Only `USER_GRANT_STATE_ACTIVE` grants count. If Zitadel is down, OPA keeps the last copy and blocks still apply. If OPA restarts, it loads the last snapshot from the role-sync volume.
- Zitadel's default HTTP client deny list includes `172.16.0.0/12`, which blocks webhooks to compose services. `ZITADEL_HTTPCLIENT_DENYLIST` repeats the defaults without that range.
- The block API and webhook endpoint have no authentication.
- A client that explicitly requests `urn:zitadel:iam:org:projects:roles` with the `demo-api` audience still gets server roles in its token. The API ignores token roles, so this only adds noise, not access.
- Zitadel v4 defaults to the separately deployed Login V2 UI. This stack sets `LOGINV2_REQUIRED=false` to use the built-in login at `/ui/login`, and skips the first-login 2FA setup prompt.
- Demo only: plain HTTP, hard-coded master key, passwords and session secret.

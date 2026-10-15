# APISIX + Zitadel + OPA demo

```
client ──► APISIX :9080 ──► openid-connect (JWT verified via Zitadel JWKS)
                        ──► opa (server roles from its own copy, sent upstream as X-Roles)
                        ──► node app :3000

role-sync ──(every 10s)──► Zitadel user grants ──► OPA data.server_roles
```

Tokens carry identity and client roles only. Server roles live in Zitadel project `demo-api`, which has role assertion off, so they never appear in a token. `role-sync` copies every user grant in the org into OPA, grouped by project. The policy maps the APISIX route to a project, looks up the caller's roles there, and APISIX forwards them to the app as `X-Roles`, replacing any client-supplied value.

| Service   | Port | Purpose |
|-----------|------|---------|
| zitadel   | 8080 | IdP (`http://zitadel.localhost:8080/ui/console`, `admin@demo.zitadel.localhost` / `Password1!`) |
| apisix    | 9080 | Gateway, standalone YAML config in `apisix/` |
| opa       | —    | Policy `opa/authz.rego`: `GET` needs a valid token, writes need the `writer` server role. Route-to-project map loaded from `generated/opa-data.json` |
| role-sync | —    | Polls Zitadel user grants (all projects, paged) and replaces `data.server_roles` in OPA: `{projectId: {userId: [roles]}}` |
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

From the command line:

```sh
cd bruno && npx @usebruno/cli run --env local
```

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
- Server role changes reach OPA within one sync interval (10s). If Zitadel is down, OPA keeps the last copy. If OPA restarts, it has no server roles until the next sync, so writes get 403 for up to 10s.
- A client that explicitly requests `urn:zitadel:iam:org:projects:roles` with the `demo-api` audience still gets server roles in its token. The API ignores token roles, so this only adds noise, not access.
- Zitadel v4 defaults to the separately deployed Login V2 UI. This stack sets `LOGINV2_REQUIRED=false` to use the built-in login at `/ui/login`, and skips the first-login 2FA setup prompt.
- Demo only: plain HTTP, hard-coded master key, passwords and session secret.

#!/bin/sh
set -eu

apk add --no-cache curl jq >/dev/null

ZITADEL=http://zitadel:8080
PAT=$(cat /bootstrap/admin.pat)

api() {
  method=$1 path=$2 body=${3:-}
  curl -fsS -X "$method" "$ZITADEL$path" \
    -H "Host: zitadel.localhost:8080" \
    -H "Authorization: Bearer $PAT" \
    -H "Content-Type: application/json" \
    ${body:+-d "$body"}
}

if [ "$(api POST /admin/v1/email/_search '{}' | jq '.result // [] | length')" = 0 ]; then
  SMTP_ID=$(api POST /admin/v1/email/smtp '{
    "description": "mailpit",
    "senderAddress": "zitadel@demo.zitadel.localhost",
    "senderName": "Zitadel",
    "host": "mailpit:1025",
    "tls": false
  }' | jq -r .id)
  api POST "/admin/v1/email/$SMTP_ID/_activate" '{}' >/dev/null
  echo "bootstrap: email provider mailpit configured"
fi

OUT=/generated/creds.env
if [ -f "$OUT" ]; then
  echo "bootstrap: $OUT exists, skipping"
  exit 0
fi

create_project() {
  name=$1 assert_roles=$2 role_key=$3 role_name=$4
  project_id=$(api POST /management/v1/projects \
    "{\"name\":\"$name\",\"projectRoleAssertion\":$assert_roles}" | jq -r .id)
  api POST "/management/v1/projects/$project_id/roles" \
    "{\"roleKey\":\"$role_key\",\"displayName\":\"$role_name\"}" >/dev/null
  echo "$project_id"
}

WEB_PROJECT_ID=$(create_project demo-web true beta-ui "Beta UI")
api POST "/management/v1/projects/$WEB_PROJECT_ID/roles" \
  '{"roleKey":"editor","displayName":"Editor"}' >/dev/null
API_PROJECT_ID=$(create_project demo-api false writer Writer)

create_client() {
  name=$1
  user_id=$(api POST /management/v1/users/machine \
    "{\"userName\":\"$name\",\"name\":\"$name\",\"accessTokenType\":\"ACCESS_TOKEN_TYPE_JWT\"}" | jq -r .userId)
  secret=$(api PUT "/management/v1/users/$user_id/secret" '{}')
  echo "$user_id" >"/tmp/$name.id"
  echo "$secret" | jq -r .clientId >"/tmp/$name.client_id"
  echo "$secret" | jq -r .clientSecret >"/tmp/$name.client_secret"
}

create_client reader
create_client writer

grant() {
  user_id=$1 project_id=$2
  shift 2
  api POST "/management/v1/users/$user_id/grants" \
    "$(jq -nc --arg p "$project_id" '{projectId: $p, roleKeys: $ARGS.positional}' --args "$@")" >/dev/null
}

grant "$(cat /tmp/writer.id)" "$API_PROJECT_ID" writer

create_oidc_app() {
  name=$1 app_type=$2 auth_method=$3 redirect=$4 post_logout=$5
  api POST "/management/v1/projects/$WEB_PROJECT_ID/apps/oidc" "{
    \"name\": \"$name\",
    \"appType\": \"$app_type\",
    \"authMethodType\": \"$auth_method\",
    \"redirectUris\": [\"$redirect\"],
    \"postLogoutRedirectUris\": [\"$post_logout\"],
    \"responseTypes\": [\"OIDC_RESPONSE_TYPE_CODE\"],
    \"grantTypes\": [\"OIDC_GRANT_TYPE_AUTHORIZATION_CODE\"],
    \"accessTokenType\": \"OIDC_TOKEN_TYPE_JWT\",
    \"accessTokenRoleAssertion\": true,
    \"idTokenRoleAssertion\": true,
    \"idTokenUserinfoAssertion\": true,
    \"devMode\": true
  }"
}

WEB_APP=$(create_oidc_app option-a-gateway OIDC_APP_TYPE_WEB OIDC_AUTH_METHOD_TYPE_BASIC \
  http://localhost:9080/a/callback http://localhost:9080/a/)
SPA_APP=$(create_oidc_app option-b-spa OIDC_APP_TYPE_USER_AGENT OIDC_AUTH_METHOD_TYPE_NONE \
  http://localhost:9080/b/ http://localhost:9080/b/)

create_human() {
  username=$1 given=$2 family=$3
  api POST /v2/users/human "{
    \"username\": \"$username\",
    \"profile\": {\"givenName\": \"$given\", \"familyName\": \"$family\"},
    \"email\": {\"email\": \"$username@example.com\", \"isVerified\": true},
    \"password\": {\"password\": \"Password1!\", \"changeRequired\": false}
  }" | jq -r .userId
}

ALICE_ID=$(create_human alice Alice Writer)
BOB_ID=$(create_human bob Bob Reader)
grant "$ALICE_ID" "$API_PROJECT_ID" writer
grant "$ALICE_ID" "$WEB_PROJECT_ID" beta-ui editor
grant "$BOB_ID" "$WEB_PROJECT_ID" beta-ui

jq -n --arg api "$API_PROJECT_ID" \
  '{routes: {"api": $api, "option-a-gateway-login": $api}}' >/generated/opa-data.json

cat >"$OUT" <<EOF
WEB_PROJECT_ID=$WEB_PROJECT_ID
API_PROJECT_ID=$API_PROJECT_ID
READER_CLIENT_ID=$(cat /tmp/reader.client_id)
READER_CLIENT_SECRET=$(cat /tmp/reader.client_secret)
WRITER_CLIENT_ID=$(cat /tmp/writer.client_id)
WRITER_CLIENT_SECRET=$(cat /tmp/writer.client_secret)
WEB_CLIENT_ID=$(echo "$WEB_APP" | jq -r .clientId)
WEB_CLIENT_SECRET=$(echo "$WEB_APP" | jq -r .clientSecret)
SPA_CLIENT_ID=$(echo "$SPA_APP" | jq -r .clientId)
EOF

echo "bootstrap: wrote $OUT"

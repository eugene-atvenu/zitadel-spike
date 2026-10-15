package apisix.authz

import rego.v1

default allow := false

token := trim_prefix(input.request.headers.authorization, "Bearer ") if {
	input.request.headers.authorization
} else := input.request.headers["x-access-token"]

sub := io.jwt.decode(token)[1].sub

project := data.routes[input.route.id]

roles := object.get(data.server_roles, [project, sub], [])

allow if input.request.method == "GET"

allow if {
	input.request.method in {"POST", "PUT", "PATCH", "DELETE"}
	"writer" in roles
}

reason := "writer role required" if not allow

headers := {"X-Roles": concat(",", roles)}

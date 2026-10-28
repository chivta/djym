# Swagger UI

Start only the local API and its database:

```sh
docker compose up -d api postgres
```

With `PORT=8090` in `.env`:

- Swagger UI: <http://10.10.0.2:8090/swagger/index.html> (`/swagger` also redirects here)
- OpenAPI JSON: <http://10.10.0.2:8090/swagger/openapi.json>

Compose publishes the API only on `10.10.0.2`; that address must exist on the
host. PostgreSQL has no published host port. API startup applies the existing
embedded migrations to the configured local database. This command does not
start the bot. Telegram login confirmation requires the bot to be running
separately; an existing valid credential can still be used without it.

The HTML and OpenAPI document are embedded in the API binary. Swagger UI's JS
and CSS come from jsDelivr, pinned to `swagger-ui-dist@5.34.0` with integrity
hashes. Browsers need internet access to that CDN; the JSON spec needs none.
The version and integration were verified against the npm registry and the
[upstream installation guide](https://github.com/swagger-api/swagger-ui/blob/master/docs/usage/installation.md).
Remote spec validation and authorization persistence are disabled.

## Authentication and Try it out

Documentation is public, including when stale credentials are supplied.
Existing API authentication and authorization are unchanged:

- **ServiceBearer**: the existing shared bot secret. Service-only endpoints
  include identity resolution, exercise listing/replacement, and Telegram login
  confirmation. Never put a real secret in the spec or in source control.
- **SessionBearer**: a user's `session_token` from native Telegram login polling.
  A user can access only their own internal user ID (not their Telegram ID).
- **SessionCookie**: the HttpOnly `gymbro_session` cookie from browser login
  polling. Cookies are browser-managed; Swagger's Authorize dialog cannot set
  them. Browser login must be started and polled in the same browser.
- Browser polling also needs the `gymbro_login` nonce cookie from browser login.

In Authorize, enter a token **without** the `Bearer ` prefix. Authorize only one
bearer scheme at a time. A supplied Authorization header takes precedence over
cookies; invalid bearer credentials never fall back to cookies. `/auth/me` and
`/auth/logout` accept user sessions, not the service secret.

Cookie-authenticated workout/program writes require JSON and
`X-Gymbro-Write: 1`; the UI adds that header automatically for these operations.
Local HTTP browser login requires `COOKIE_SECURE=false`; use HTTPS or native
bearer login otherwise. No local secret or cookie setting is changed by this
feature. Try it out sends real requests and mutations to the same API origin.

## Maintaining the contract

`internal/server/docs/openapi.json` describes all existing API operations, wire
schemas, revision fields, pagination, and authentication. Update it alongside
handler or wire-type changes. Rebuild/restart the API after editing the embedded
HTML or JSON (the existing Air watcher watches Go and SQL, not these assets).

```sh
go test ./...
go vet ./...
```

`internal/server/docs_test.go` checks the production router's public docs,
redirects and content types, one-to-one API route/spec coverage, security
schemes, strict request schemas, wire-field coverage, and continued rejection
of anonymous/invalid API credentials.

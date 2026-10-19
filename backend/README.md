# AppWeave backend

Offline-first TypeScript API foundation for AppWeave. It uses Fastify, PostgreSQL when `DATABASE_URL` is set, and the JSON file store for offline development and tests.

## Setup and operation

Requires Node 20 (`.nvmrc`). From this directory:

```sh
npm ci
cp .env.example .env   # optional for non-Docker runs; Docker generates persistent secrets automatically
npm run build
npm start
```

Run the complete offline check with `npm test` (or `npm run typecheck`). Docker builds and runs the same service with `docker build -f backend/Dockerfile -t appweave-backend . && docker run --rm -p 3000:3000 appweave-backend`.

### PostgreSQL persistence

The Compose stack starts PostgreSQL 16 and configures the API with `DATABASE_URL`. On first API startup, `backend/migrations/001_initial.sql` is applied automatically. The adapter stores the complete application state in a migration-safe JSONB document and mirrors users, tokens, projects/settings, provider configs, survey responses, audits, builds, deployments, and versions into queryable tables. Existing JSON storage remains the default when `DATABASE_URL` is unset.

```sh
cp backend/.env.example backend/.env # optional local overrides; never commit secrets
docker compose up --build
# API: http://localhost:3000/health, dashboard: http://localhost:8080
docker compose down                 # retain PostgreSQL volume
docker compose down -v              # remove local database and app data
```

For a non-Docker PostgreSQL server, set `DATABASE_URL` (and optionally `DATABASE_POOL_SIZE`) in `backend/.env`, then run `npm ci`, `npm run build`, and `npm start` from `backend/`. The database user must be allowed to create tables in the selected database. Do not place passwords or API keys in source files; use environment variables or an untracked `.env` file.

## API

`GET /health` is unauthenticated. SDK routes are under `/api/v1`: register/login, owned project listing and creation, project-scoped Product CRUD, specification versions, preview/production deployment metadata, Git-backed project versions (snapshots), changed-file comparison, validated rollback, audit logs, and authenticated AI generation through configured Gemini, OpenAI, OpenRouter, or Groq providers. Provider keys are encrypted at rest with AES-256-GCM and are never returned or logged. Set `AI_ENCRYPTION_KEY` before starting the server (tests use an explicit test key). Register/login also sets an HttpOnly `appweave_session` cookie (SameSite=Lax); configure `SESSION_COOKIE_SECURE` and `SESSION_COOKIE_MAX_AGE` for deployment. `GET /api/v1/auth/me` reads either the cookie or `Authorization: Bearer <token>`, and `POST /api/v1/auth/logout` clears the cookie. Browser clients should send credentials and an allowed `Origin`; state-changing requests with a disallowed Origin are rejected. User preferences are available at `GET/PATCH /api/v1/me/preferences` and are isolated by authenticated user. Send `Authorization: Bearer <token>` for SDK compatibility. All errors use `{error:{code,message,requestId}}`; rate limiting and configurable CORS origin checks are enabled.

`POST /api/v1/projects/:projectId/builds` and the existing deployment/publish routes run a bounded artifact builder. `GET /api/v1/projects/:projectId/builds` and `GET /api/v1/projects/:projectId/builds/:buildId` expose persisted status, logs, runtime mode, and artifact names. `GET /api/v1/projects/:projectId/runtime/status` reports whether an isolated Docker worker is available. `DELETE /api/v1/projects/:projectId` removes owned source, artifacts, and project records.

### Survey response storage

Authenticated project owners can submit and read responses with `POST`/`GET /api/v1/projects/:projectId/survey-responses`. The API requires `consent: true`, limits payloads to 64 KiB and 100 answer fields, persists responses in the configured store, and never places answer values in audit metadata. Public generated forms can use `POST /api/survey-responses` with the project's `publicClientId` (or `projectId`) plus `surveyId`, `answers`, and `consent: true`; that route is rate-limited and returns only response metadata. Configure `ALLOWED_ORIGINS` and use a durable database adapter before exposing public collection beyond local development.

### Project build/runtime limitation

Builds validate bounded source and generate a pinned React/Vite template plus lockfile for an empty project with a specification. When `package.json` exists, readiness requires a successful opt-in Docker worker build and validated `dist/index.html` with existing local assets. Only genuinely static existing projects use artifact-only copying; failed/unavailable package builds never become static shells. Output is staged before promotion, preserving the last successful preview on failure. The API never executes generated project code in its own process.

Workers remain disabled by default. Named-volume mode requires Docker Engine **26.0+ (API 1.45+)** and a CLI supporting `--mount volume-subpath`. Only the selected project's subdirectory is mounted at `/workspace`; unsupported subpath mounts fail closed without retrying a whole-volume mount. The configured volume must already exist. Compose defaults the worker volume name to its project-prefixed `${COMPOSE_PROJECT_NAME:-appweave}_appweave-projects`; leave the environment override empty or set it to the actual existing volume name, never create/rename a volume to hide existing data. With no named volume in local host mode, the worker bind-mounts only the selected project directory. See the root README's optional worker instructions for inspecting an existing installation.

## MCP Apps preview UI

The existing `POST /mcp` endpoint also advertises `render_project_preview`, backed by `ui://appweave/project-preview.html`. Clients can fetch it with `resources/read`; the resource uses `text/html;profile=mcp-app` and includes restrictive CSP/frame metadata. The tool returns project status and a preview link with the same ownership check as the other project tools.

The embedded UI is deliberately a graceful fallback: it does not claim that an iframe can reach `localhost` through Secure MCP Tunnel. When the MCP host cannot reach the preview URL, it shows an explicit explanation and an ordinary link to open separately. No provider keys, MCP tokens, or other secrets are included in tool output or UI resource content.

## Local MCP connector

`POST /mcp` exposes an authenticated MCP JSON-RPC connector for local clients. The recommended credential is a dashboard-created MCP connection token, sent as `Authorization: Bearer <MCP_TOKEN>`; legacy AppWeave JWT bearer tokens remain supported for local development. Cookie-only sessions are not used by MCP clients.

Create and manage connection tokens in **Settings → MCP Connections**, or use these authenticated REST endpoints:

```text
POST   /api/v1/mcp/tokens       { "name": "Claude local" }
GET    /api/v1/mcp/tokens
POST   /api/v1/mcp/tokens/:id/revoke
POST   /api/v1/mcp/connection-test
```

The raw token is returned only by the create response and is never returned by list or revoke. The dashboard also generates a copyable MCP client configuration containing the endpoint and bearer header.

The connector supports `initialize`, `ping`, `tools/list`, and `tools/call` for these project tools:

- `list_projects`, `create_project`, `get_project`
- `list_files`, `read_file`, `search_code`
- `write_file`, `apply_patch`, `rename_file`, `delete_file`
- `create_checkpoint`

All project tools enforce ownership. File paths are restricted to the selected project's workspace; absolute paths, traversal, null bytes, and symlink traversal are rejected. Writes are audited, and checkpoints are stored through the existing Git-backed version repository. Notifications return HTTP `202` with an empty body. Invalid or unknown JSON-RPC requests use standard JSON-RPC error objects.

Example local client configuration (replace the token with a locally generated session token; do not commit it):

```json
{
  "mcpServers": {
    "appweave-local": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <JWT_FROM_LOGIN>" }
    }
  }
}
```

Start the backend with `npm run dev` or `npm start`, obtain a token by logging in, and point an MCP-compatible client at the URL above. The local connector is intended for development; use a strong `JWT_SECRET` and TLS before exposing it beyond localhost.

### Local MCP test mode (explicit opt-in)

For connector smoke tests where creating or pasting a token on every run is inconvenient, set **both** `NODE_ENV=development` (or `test`) and `APPWEAVE_MCP_LOCAL_TEST_MODE=true`. In this mode, only `POST /mcp` accepts requests without a bearer token and assigns them to the fixed local test identity `local-mcp-test-user`; normal REST routes still require authentication. The flag defaults to `false`, and the server refuses to activate it when `NODE_ENV=production`, so PAT, JWT, and OAuth bearer authentication remain unchanged by default.

This mode is intentionally unsafe for anything beyond a local test process: anyone who can reach the MCP port can read or modify the local test identity's projects. Do not enable it on a shared host, tunnel, or production deployment. From the repository root, the one-command Docker path is:

```sh
./scripts/start-mcp-local.sh
```

It starts the Compose stack in development mode with the flag enabled and contains no secrets. Stop it with `docker compose down`; use `docker compose down -v` for a clean test reset. Remote team testing must use MCP connection tokens or OAuth/PAT authentication over a protected HTTPS deployment; this local bypass cannot safely provide shared remote access or per-user ownership.

### Temporary ngrok tunnel

For external MCP-client testing, configure ngrok outside Git and run the backend tunnel from this directory:

```sh
NGROK_AUTHTOKEN=replace-me
NGROK_DOMAIN=your-reserved-domain.ngrok-free.app
npm run tunnel
```

The script forwards `localhost:3000` by default and prints the public `/mcp` URL. Put the token and reserved domain in `backend/.env`, not in source files. A tunnel makes the development backend public, so use a temporary test account and stop it when testing is complete.

Project versions are stored in server-owned repositories below `PROJECT_WORKSPACE_ROOT` (one repository per project); only generated project specification state is committed, never backend source. If Git is unavailable, version metadata and file content remain usable through the JSON store fallback. Rollback validates the target before creating a new version and does not rewind products or other application records.

The file-backed store is intentionally dependency-free and persists at `DATA_FILE`. It provides atomic-in-process writes and ownership checks on every project-scoped route. It is not intended as a horizontally concurrent production database.

## AI providers

Configure a provider for an owned project with `PATCH /api/v1/projects/:projectId/providers/:provider`, using `gemini`, `openai`, or `openrouter`, a provider base URL/model, and `key` (or `apiKey`). The key is encrypted server-side with `AI_ENCRYPTION_KEY`; provider listing responses expose only a redacted suffix. Generate with `POST /api/v1/ai/generate` and `{ "projectId": "...", "prompt": "..." }`. Responses are normalized and validated as application specifications. Provider calls use a bounded timeout and return actionable error codes. Configure the timeout with `AI_PROVIDER_TIMEOUT_MS` in milliseconds; invalid or non-positive values use the safe 120000 ms default.

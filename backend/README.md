# AppWeave backend

Offline-first TypeScript API foundation for AppWeave. It uses Fastify and a JSON file store (safe for local development and tests; use a durable database adapter for multi-instance production).

## Setup and operation

Requires Node 20 (`.nvmrc`). From this directory:

```sh
npm ci
cp .env.example .env   # optional for non-Docker runs; Docker generates persistent secrets automatically
npm run build
npm start
```

Run the complete offline check with `npm test` (or `npm run typecheck`). Docker builds and runs the same service with `docker build -f backend/Dockerfile -t appweave-backend . && docker run --rm -p 3000:3000 appweave-backend`.

## API

`GET /health` is unauthenticated. SDK routes are under `/api/v1`: register/login, owned project listing and creation, project-scoped Product CRUD, specification versions, preview/production deployment metadata, Git-backed project versions (snapshots), changed-file comparison, validated rollback, audit logs, and authenticated AI generation through configured Gemini, OpenAI, OpenRouter, or Groq providers. Provider keys are encrypted at rest with AES-256-GCM and are never returned or logged. Set `AI_ENCRYPTION_KEY` before starting the server (tests use an explicit test key). Register/login also sets an HttpOnly `appweave_session` cookie (SameSite=Lax); configure `SESSION_COOKIE_SECURE` and `SESSION_COOKIE_MAX_AGE` for deployment. `GET /api/v1/auth/me` reads either the cookie or `Authorization: Bearer <token>`, and `POST /api/v1/auth/logout` clears the cookie. Browser clients should send credentials and an allowed `Origin`; state-changing requests with a disallowed Origin are rejected. User preferences are available at `GET/PATCH /api/v1/me/preferences` and are isolated by authenticated user. Send `Authorization: Bearer <token>` for SDK compatibility. All errors use `{error:{code,message,requestId}}`; rate limiting and configurable CORS origin checks are enabled.

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

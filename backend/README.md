# AppWeave backend

Offline-first TypeScript API foundation for AppWeave. It uses Fastify and a JSON file store (safe for local development and tests; use a durable database adapter for multi-instance production).

## Setup and operation

Requires Node 20 (`.nvmrc`). From this directory:

```sh
npm ci
cp .env.example .env   # set long random JWT_SECRET and AI_ENCRYPTION_KEY values
npm run build
npm start
```

Run the complete offline check with `npm test` (or `npm run typecheck`). Docker builds and runs the same service with `docker build -f backend/Dockerfile -t appweave-backend . && docker run --rm -p 3000:3000 appweave-backend`.

## API

`GET /health` is unauthenticated. SDK routes are under `/api/v1`: register/login, owned project listing and creation, project-scoped Product CRUD, specification versions, preview/production deployment metadata, Git-backed project versions (snapshots), changed-file comparison, validated rollback, audit logs, and authenticated AI generation through configured Gemini, OpenAI, or OpenRouter providers. Provider keys are encrypted at rest with AES-256-GCM and are never returned or logged. Set `AI_ENCRYPTION_KEY` before starting the server (tests use an explicit test key). Send `Authorization: Bearer <token>`. All errors use `{error:{code,message,requestId}}`; rate limiting and configurable CORS origin checks are enabled.

Project versions are stored in server-owned repositories below `PROJECT_WORKSPACE_ROOT` (one repository per project); only generated project specification state is committed, never backend source. If Git is unavailable, version metadata and file content remain usable through the JSON store fallback. Rollback validates the target before creating a new version and does not rewind products or other application records.

The file-backed store is intentionally dependency-free and persists at `DATA_FILE`. It provides atomic-in-process writes and ownership checks on every project-scoped route. It is not intended as a horizontally concurrent production database.

## AI providers

Configure a provider for an owned project with `PATCH /api/v1/projects/:projectId/providers/:provider`, using `gemini`, `openai`, or `openrouter`, a provider base URL/model, and `key` (or `apiKey`). The key is encrypted server-side with `AI_ENCRYPTION_KEY`; provider listing responses expose only a redacted suffix. Generate with `POST /api/v1/ai/generate` and `{ "projectId": "...", "prompt": "..." }`. Responses are normalized and validated as application specifications. Provider calls use a bounded timeout and return actionable error codes.

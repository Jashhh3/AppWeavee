# AppWeave

AppWeave is a self-contained AI application builder with a Fastify/TypeScript API, React dashboard, offline JSON persistence, and a TypeScript SDK.

## Requirements

- Node.js **20.15.1**, pinned in `.nvmrc`
- npm and GNU Make
- Docker Engine with Docker Compose v2 for containers

No database or provider credentials are required for local development or the offline checks.

## Automatic Docker setup

Docker performs the complete first-run setup. The API container generates `JWT_SECRET` and `AI_ENCRYPTION_KEY` on first startup and stores them in the persistent `appweave-data` volume. Later restarts reuse the same secrets automatically. No host `.env` file is required for local Docker use.

```powershell
docker compose up --build -d
```

Dashboard: `http://localhost:8080`
API health: `http://localhost:3000/health`

MCP connections are managed from **Settings → MCP Connections**. Create a named connection token there, copy it once, and use the generated client configuration; raw tokens are never shown again. Local MCP clients connect to `http://localhost:3000/mcp` using that token as `Authorization: Bearer <MCP_TOKEN>`. The MCP endpoint exposes project discovery, project creation, safe file read/write/search, file rename/delete, and Git-backed checkpoint tools. See `backend/README.md#local-mcp-connector` for the API and client configuration details.
For local connector smoke tests only, run `./scripts/start-mcp-local.sh`. It sets `NODE_ENV=development` and `APPWEAVE_MCP_LOCAL_TEST_MODE=true`, allowing unauthenticated requests to `http://localhost:3000/mcp` with a fixed local test identity. This is disabled by default and forcibly disabled in production; never use it on a shared host or tunnel. Remote team testing requires a token or OAuth/PAT on protected HTTPS. See `backend/README.md#local-mcp-test-mode` for details.

For temporary external testing, the backend includes `npm run tunnel`, which forwards port 3000 through ngrok. Set `NGROK_AUTHTOKEN` and, optionally, `NGROK_DOMAIN` in the untracked `backend/.env`; never commit either value. This exposes the development backend publicly and does not replace the production OAuth setup.

To inspect services:

```powershell
docker compose ps
docker compose logs api
```

To stop without deleting data:

```powershell
docker compose down
```

`docker compose down -v` deletes the volume, users, projects, provider configuration, and generated data. Use it only for a deliberate clean reset.

### Optional isolated React/Vite worker

The worker is disabled by default. Package-based projects require a successful isolated build; only existing static projects can use artifact-only previews. To run generated React/Vite builds in short-lived, isolated containers locally, build the API image (it includes the Docker CLI) and opt in with the worker Compose overlay:

```sh
APPWEAVE_DOCKER_WORKER=true docker compose -f docker-compose.yml -f docker-compose.worker.yml up --build
```

Named-volume workers require **Docker Engine 26.0+ (API 1.45+)** and a Docker CLI supporting `--mount volume-subpath` (the API image bundles CLI 26.1.4). The overlay grants the API access to the local Docker socket. Each worker mounts only the selected project's subdirectory via `volume-subpath`, never the whole projects volume. Unsupported engines fail the build; there is no broader-mount fallback. In local host mode (no `APPWEAVE_DOCKER_WORKER_VOLUME`), only the selected project directory is bind-mounted.

Compose keeps its existing managed volume declaration and data. The worker volume defaults to `${COMPOSE_PROJECT_NAME:-appweave}_appweave-projects`, matching Compose's project-prefixed name (including `docker compose -p NAME`). Leave `APPWEAVE_DOCKER_WORKER_VOLUME` empty in `.env` to use that default. For an existing/custom installation, inspect the API container's mounts with `docker inspect "$(docker compose ps -q api)" --format '{{json .Mounts}}'` and set `APPWEAVE_DOCKER_WORKER_VOLUME` to the **existing volume's Name** mounted at `/data/projects`. Remove an old `APPWEAVE_DOCKER_WORKER_VOLUME=appweave-projects` override if that is not its actual name. The worker checks that the volume exists before launching; it does not create a replacement volume. Do not rename the Compose volume or delete volumes to resolve a name mismatch.

The worker runs `npm ci --ignore-scripts` when `package-lock.json` exists (`npm install --ignore-scripts` only for legacy projects without a lock), then `npm run build`, with a 30-second timeout, 512 MiB memory limit, bounded logs, dropped capabilities, `no-new-privileges`, read-only container filesystem, and a temporary filesystem. Failed or unavailable package builds are reported as failed, preserving the last successful preview. Preview and production routes serve scoped assets from the active build's `dist`; extensionless SPA navigation falls back to its index only when that build's specification explicitly sets `frontend.routing` to `spa`. Missing asset requests remain 404. Do not enable this overlay on a shared host unless Docker socket access is part of the host's trust boundary.

For non-Docker development, the optional `scripts/bootstrap-env.ps1` and `scripts/bootstrap-env.sh` helpers still create a local `.env`.

## Setup

From the repository root:

```sh
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
(cd backend && npm ci)
(cd frontend && npm ci)
(cd sdk && npm ci)
```

Open `backend/.env` and replace the placeholder `JWT_SECRET` with a randomly generated server-only value. For example, in a Linux/macOS terminal:

```sh
openssl rand -hex 32
```

On PowerShell, use Node.js:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the result into `backend/.env` as `JWT_SECRET=...`. Do not put this value in `frontend/.env.local`, browser code, screenshots, or Git. Set `AI_PROVIDER_TIMEOUT_MS` to change the provider request timeout in milliseconds (defaults to `180000`, or three minutes). The backend now loads `backend/.env` automatically; Vite loads `frontend/.env.local` automatically. `.env.example` files contain placeholders only.

## Run locally

Start the API:

```sh
cd backend
npm run build
npm start
```

In a second terminal, start the dashboard:

```sh
cd frontend
npm run dev
```

Open `http://localhost:5173`. The API health endpoint is `http://localhost:3000/health`.

## Test and build

Run the single offline validation command:

```sh
make test
```

This uses each committed npm lockfile with `npm ci --offline`, runs backend tests and typechecking, the frontend smoke test, and the SDK build. Install dependencies once with network access during setup before running offline checks.

Build all workspaces with:

```sh
make build
```

## Docker Compose

Build and run the API and dashboard:

```sh
docker compose up --build
```

The API is at `http://localhost:3000`; the dashboard is at `http://localhost:8080`. Set strong `JWT_SECRET` and `AI_ENCRYPTION_KEY` values in `.env` for shared environments. The compose setup allows the dashboard origins on port 8080. Stop the stack with `docker compose down`.

Docker Compose starts PostgreSQL 16 alongside the API. `DATABASE_URL` is supplied to the API and the migration in `backend/migrations/001_initial.sql` runs automatically. Core account, token, project, provider, survey, audit, build, deployment, and version records are mirrored into PostgreSQL; the JSON state document preserves compatibility with the existing store. The JSON store and generated secrets are mounted in `appweave-data`, while PostgreSQL uses `postgres-data`. Remove all local data with `docker compose down -v`.

## Deploy

On a host with Docker Engine and Compose v2, copy the repository and `.env.example` to `.env`, set `JWT_SECRET`, then run:

```sh
docker compose build
docker compose up -d
docker compose ps
curl http://localhost:3000/health
```

Use the host's TLS reverse proxy and network policy for externally exposed deployments. Set `AI_PROVIDER_TIMEOUT_MS` in `.env` when provider requests need a different bounded timeout (default: `180000` ms). For Docker, set `AI_PROVIDER_TIMEOUT_MS=300000` in a host `.env` file if the selected NVIDIA model routinely needs up to five minutes.

## Gemini model configuration

Gemini model availability depends on the provider account and API version. AppWeave includes selectable model IDs in the dashboard, including `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.5-flash`, and `gemini-3.1-pro-preview`. Use **Settings → AI Providers → Test connection** to verify the saved key and selected model. Never paste provider API keys into chat, source files, screenshots, or Git; rotate a key immediately if it is exposed.

## NVIDIA model configuration

NVIDIA is available as an OpenAI-compatible provider. In **Settings → AI Providers**, choose **NVIDIA**, keep the default base URL `https://integrate.api.nvidia.com/v1` unless your deployment uses another compatible endpoint, and save an NVIDIA API key. AppWeave includes these selectable model IDs:

- `z-ai/glm-5.3-flash`
- `deepseek-ai/deepseek-v4.1-flash`
- `meta/muse-glimmer-30b`
- `poolside/laguna-xs-2.1`

Model availability depends on the NVIDIA account and API access. Use **Test connection** before selecting a model for AI Builder. API keys are encrypted by the backend and are never returned to the browser after saving. If a key is exposed, revoke it in NVIDIA and create a replacement immediately; do not add keys to `.env.example`, source files, screenshots, or Git.

## Workspace layout

- `backend/`: Fastify API, authorization, persistence, and tests
- `frontend/`: React + TypeScript + Vite dashboard
- `sdk/`: documented TypeScript client
- `docker-compose.yml`: API and dashboard services

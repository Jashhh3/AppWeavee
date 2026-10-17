# AppWeave

AppWeave is a self-contained AI application builder with a Fastify/TypeScript API, React dashboard, offline JSON persistence, and a TypeScript SDK.

## Requirements

- Node.js **20.15.1**, pinned in `.nvmrc`
- npm and GNU Make
- Docker Engine with Docker Compose v2 for containers

No database or provider credentials are required for local development or the offline checks.

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

Paste the result into `backend/.env` as `JWT_SECRET=...`. Do not put this value in `frontend/.env.local`, browser code, screenshots, or Git. The backend now loads `backend/.env` automatically; Vite loads `frontend/.env.local` automatically. `.env.example` files contain placeholders only.

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

The API JSON store is mounted in the named `appweave-data` volume. Remove local data with `docker compose down -v`.

## Deploy

On a host with Docker Engine and Compose v2, copy the repository and `.env.example` to `.env`, set `JWT_SECRET`, then run:

```sh
docker compose build
docker compose up -d
docker compose ps
curl http://localhost:3000/health
```

Use the host's TLS reverse proxy and network policy for externally exposed deployments.

## Gemini model configuration

Gemini model availability depends on the provider account and API version. AppWeave includes selectable model IDs in the dashboard, including `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.5-flash`, and `gemini-3.1-pro-preview`. Use **Settings → AI Providers → Test connection** to verify the saved key and selected model. Never paste provider API keys into chat, source files, screenshots, or Git; rotate a key immediately if it is exposed.

## Workspace layout

- `backend/`: Fastify API, authorization, persistence, and tests
- `frontend/`: React + TypeScript + Vite dashboard
- `sdk/`: documented TypeScript client
- `docker-compose.yml`: API and dashboard services

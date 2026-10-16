# AppWeave

AppWeave is a self-contained AI application builder and managed backend foundation. The initial vertical slice provides account authentication, owned projects, project-scoped Product CRUD, validated application specifications, internal snapshots, preview/production deployment records, audit logs, and a responsive dashboard. No GitHub account is required.

## What is implemented

- **Private backend engine:** Fastify/TypeScript service owns storage, authorization, migrations/specifications, and secrets. The frontend receives only public project configuration.
- **Tenant isolation:** every protected project route checks the authenticated owner; cross-project reads and writes return `404`.
- **Persistence:** offline file-backed store for reproducible local development and tests. Replace the `Store` adapter with PostgreSQL for concurrent production deployments; the API boundary remains stable.
- **AI workflow:** server-side provider abstraction with a safe no-network stub until a provider key is configured. Generated output is treated as review data and is not executed.
- **Internal versions:** snapshots are project-scoped and rollback restores application specification state without deleting customer records.
- **Dashboard:** real login/register, live overview metrics, project creation/listing, schema/data explorer, AI proposal review, and operational navigation with explicit not-yet-connected states.
- **SDK:** `sdk/` provides a documented TypeScript client using a public client identifier and bearer sessions.

## Requirements

Node.js 20 (pinned in `.nvmrc`) and npm. Docker Compose is optional. No external database or provider credentials are required for the offline check.

## Run locally

```sh
cp .env.example .env
cd backend && npm ci && npm test && npm run typecheck && npm run build
JWT_SECRET=local-development-secret npm start

# in another terminal
cd frontend && npm ci && printf 'VITE_API_URL=http://localhost:3000\n' > .env.local && npm run dev
```

Open the Vite URL, create an account, create a project, and use the dashboard. The backend API is at `http://localhost:3000`; health is `GET /health`.

## Single test command

`make test` runs backend integration tests, backend typechecking, and the frontend smoke test completely offline using the committed lockfiles and local npm caches. `make build` builds both applications.

## Docker

`docker compose up --build` starts the API on port 3000 and dashboard on port 8080. Set a strong `JWT_SECRET` in the environment for any shared deployment. The local JSON store is mounted in the `appweave-data` volume.

## Backup and restore

For the local adapter, stop the API, copy the mounted `DATA_FILE` to a protected backup location, and restore it before starting the service again. Production PostgreSQL deployments should use encrypted scheduled snapshots and a tested point-in-time restore procedure; this remains an infrastructure setup step rather than a browser feature.

## Deliberate gaps

PostgreSQL provisioning, encrypted BYOK persistence, real external model adapters, hosted preview build workers, atomic frontend deployment, and custom domains are interfaces/records in this first version, not claimed as operational. They must be added behind the same authorization and versioning boundaries before production launch.

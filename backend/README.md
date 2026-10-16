# AppWeave backend

Offline-first TypeScript API foundation for AppWeave. It uses Fastify and a JSON file store (safe for local development and tests; use a durable database adapter for multi-instance production).

## Setup and operation

Requires Node 20 (`.nvmrc`). From this directory:

```sh
npm ci
cp .env.example .env   # set a long JWT_SECRET outside development
npm run build
npm start
```

Run the complete offline check with `npm test` (or `npm run typecheck`). Docker builds and runs the same service with `docker build -t appweave-backend . && docker run --rm -p 3000:3000 appweave-backend`.

## API

`GET /health` is unauthenticated. SDK routes are under `/api/v1`: register/login, owned project listing and creation, project-scoped Product CRUD, specification versions, preview/production deployment metadata, snapshots and rollback, audit logs, and an authenticated safe AI stub. Send `Authorization: Bearer <token>`. All errors use `{error:{code,message,requestId}}`; rate limiting and configurable CORS origin checks are enabled.

The file-backed store is intentionally dependency-free and persists at `DATA_FILE`. It provides atomic-in-process writes and ownership checks on every project-scoped route. It is not intended as a horizontally concurrent production database.

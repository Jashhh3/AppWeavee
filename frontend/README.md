# AppWeave frontend

React + TypeScript + Vite dashboard UI for the AppWeave developer workspace.

## Setup

Requires Node 20 (`.nvmrc`).

```sh
npm ci
cp .env.example .env
npm run dev
```

Set `VITE_API_URL` to the backend origin and `VITE_PUBLIC_CLIENT_ID` to the public client identifier. When the API is absent, screens show explicit unavailable states and do not fabricate operational data.

## Checks

```sh
npm run build
npm test
```

## Production

Build with `npm run build` and serve `dist/` with any static host. A Dockerfile is included for a reproducible nginx image.

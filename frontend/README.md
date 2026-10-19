# AppWeave frontend

React + TypeScript + Vite dashboard UI for the AppWeave developer workspace.

## Setup

Requires Node 20 (`.nvmrc`).

```sh
npm ci
cp .env.example .env
npm run dev
```

Set `VITE_API_URL` to the backend origin and `VITE_PUBLIC_CLIENT_ID` to the public client identifier. Generated survey frontends can import `submitSurveyResponse` from `src/surveyResponseClient.ts`; it posts `{ surveyId?, answers, consent: true }` to `/api/v1/projects/{projectId}/survey-responses` by default. Set `VITE_SURVEY_RESPONSE_URL` to an absolute URL or a template containing `{projectId}` when the response service is hosted elsewhere. The client includes browser credentials and exposes structured `SurveyResponseError` details for success/error UI states.

## Checks

```sh
npm run build
npm test
```

## Production

Build with `npm run build` and serve `dist/` with any static host. A Dockerfile is included for a reproducible nginx image.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';

describe('survey response storage', () => {
  let app: FastifyInstance | undefined;
  let dir: string;

  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'appweave-survey-'));
    app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'test-secret', encryptionKey: 'test-encryption-key' });
    const owner = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'survey-owner@example.com', password: 'correct horse battery staple' } });
    const other = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'survey-other@example.com', password: 'correct horse battery staple' } });
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { authorization: `Bearer ${owner.json().token}` }, payload: { name: 'Survey' } });
    return { owner: owner.json().token as string, other: other.json().token as string, projectId: project.json().id as string, publicClientId: project.json().publicClientId as string };
  }

  it('submits, reads back, and persists a consented response without logging answers', async () => {
    const { owner, projectId } = await setup();
    const answer = 'health detail that must not be logged';
    const submitted = await app!.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/survey-responses`, headers: { authorization: `Bearer ${owner}` }, payload: { surveyId: 'intake', consent: true, answers: { symptoms: answer, age: 42 } } });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json()).toMatchObject({ projectId, surveyId: 'intake', consent: true, answers: { symptoms: answer, age: 42 } });
    const listed = await app!.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/survey-responses`, headers: { authorization: `Bearer ${owner}` } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().responses).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(await readFile(join(dir, 'db.json'), 'utf8')).audits)).not.toContain(answer);
    await app!.close();
    app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'test-secret', encryptionKey: 'test-encryption-key' });
    const reloaded = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/survey-responses`, headers: { authorization: `Bearer ${owner}` } });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json().responses[0].answers.symptoms).toBe(answer);
  });

  it('enforces authentication and project ownership', async () => {
    const { owner, other, projectId } = await setup();
    const body = { consent: true, answers: { rating: 5 } };
    expect((await app!.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/survey-responses`, payload: body })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/survey-responses`, headers: { authorization: `Bearer ${other}` }, payload: body })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/survey-responses`, headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/survey-responses`, headers: { authorization: `Bearer ${owner}` }, payload: body })).statusCode).toBe(201);
  });

  it('requires explicit consent and bounds the payload', async () => {
    const { owner, projectId } = await setup();
    const withoutConsent = await app!.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/survey-responses`, headers: { authorization: `Bearer ${owner}` }, payload: { answers: { note: 'private' }, consent: false } });
    expect(withoutConsent.statusCode).toBe(400);
    expect(withoutConsent.json().error.message).toContain('Consent');
    const oversized = await app!.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/survey-responses`, headers: { authorization: `Bearer ${owner}` }, payload: { consent: true, answers: { note: 'x'.repeat(70_000) } } });
    expect(oversized.statusCode).toBe(413);
  });

  it('accepts an anonymous public response only for a known project client id', async () => {
    const { projectId, publicClientId } = await setup();
    const submitted = await app!.inject({ method: 'POST', url: '/api/survey-responses', payload: { publicClientId, surveyId: 'nethasethu', consent: true, answers: { interest: 'yes' } } });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json()).toMatchObject({ projectId, surveyId: 'nethasethu', consent: true });
    expect(submitted.json().answers).toBeUndefined();
    const invalid = await app!.inject({ method: 'POST', url: '/api/survey-responses', payload: { publicClientId: 'wrong-client', consent: true, answers: { interest: 'yes' } } });
    expect(invalid.statusCode).toBe(404);
  });
});

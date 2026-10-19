import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server.js';

describe('database test endpoint', () => {
  let app: any; let dir: string; let cookie: string; let projectId: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appweave-db-test-')); app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'db-test-secret', encryptionKey: 'db-test-encryption' });
    const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'db-test@example.com', password: 'correct horse battery staple' } });
    cookie = String(registered.headers['set-cookie']).split(';')[0];
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie }, payload: { name: 'Database Connection Test' } });
    projectId = project.json().id;
  });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  it('fails explicitly when PostgreSQL provisioning is unavailable', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/database-test', headers: { cookie }, payload: { projectId, fullName: 'Test User', email: 'test@example.com', phone: '123', city: 'Pune', testMessage: 'hello' } });
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('DATABASE_NOT_PROVISIONED');
  });
  it('does not allow another authenticated owner to access the test project', async () => {
    const other = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'other-db-test@example.com', password: 'correct horse battery staple' } });
    const otherCookie = String(other.headers['set-cookie']).split(';')[0];
    const response = await app.inject({ method: 'GET', url: `/api/database-test/${projectId}`, headers: { cookie: otherCookie } });
    expect(response.statusCode).toBe(404);
  });
});

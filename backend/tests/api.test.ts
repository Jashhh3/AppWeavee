import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('AppWeave API', () => {
  let app: FastifyInstance; let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'appweave-')); app = await buildApp({ dataFile: join(dir, 'db.json'), jwtSecret: 'test-secret' }); });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  async function register(email: string) { const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'correct horse battery staple' } }); expect(r.statusCode).toBe(201); return r.json().token as string; }
  it('registers, authenticates, and keeps projects isolated', async () => {
    const a = await register('a@example.com'); const b = await register('b@example.com');
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { authorization: `Bearer ${a}` }, payload: { name: 'A' } });
    expect(project.statusCode).toBe(201); const id = project.json().id;
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: { authorization: `Bearer ${b}` } })).statusCode).toBe(404);
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/projects' }); expect(unauth.statusCode).toBe(401);
  });
  it('validates and performs Product CRUD plus snapshot rollback', async () => {
    const auth = { authorization: `Bearer ${await register('owner@example.com')}` };
    const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Catalog' } }); const id = p.json().id;
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/products`, headers: auth, payload: { name: '', sku: 'x', price: 1 } })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/products`, headers: auth, payload: { name: 'Chair', sku: 'CHAIR-1', price: 10 } }); expect(created.statusCode).toBe(201);
    const snap = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/snapshots`, headers: auth, payload: { reason: 'before change' } });
    await app.inject({ method: 'DELETE', url: `/api/v1/projects/${id}/products/${created.json().id}`, headers: auth });
    const live = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/products`, headers: auth, payload: { name: 'Desk', sku: 'DESK-1', price: 20 } });
    expect(live.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/snapshots/${snap.json().id}/rollback`, headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/products`, headers: auth })).json().products).toHaveLength(1); // code/spec rollback never rewinds customer data
  });
  it('versions specifications and records deployment metadata', async () => {
    const auth = { authorization: `Bearer ${await register('deploy@example.com')}` }; const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Deploy' } }); const id = p.json().id;
    const spec = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: { Product: { sku: 'string' } } } }); expect(spec.json().version).toBe(1);
    const dep = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/deployments`, headers: auth, payload: { environment: 'preview', version: 1 } }); expect(dep.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/audit-logs`, headers: auth })).json().logs.length).toBeGreaterThan(0);
  });
});

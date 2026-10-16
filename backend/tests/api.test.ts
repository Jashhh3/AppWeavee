import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { buildApp } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('AppWeave API', () => {
  let app: FastifyInstance; let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'appweave-')); app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'test-secret' }); });
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

  it('creates Git-backed versions, compares them, validates rollback, and preserves data', async () => {
    const owner = await register('versions@example.com'); const other = await register('other@example.com');
    const auth = { authorization: `Bearer ${owner}` }; const otherAuth = { authorization: `Bearer ${other}` };
    const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Versions' } }); const id = p.json().id;
    const product = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/products`, headers: auth, payload: { name: 'Saved', sku: 'SAVE', price: 3 } });
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: { Product: { sku: 'string' } } } });
    const v1 = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/versions`, headers: auth, payload: { reason: 'first' } }); expect(v1.statusCode).toBe(201); expect(v1.json().commitSha).toMatch(/^[0-9a-f]{40}$/);
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: { Product: { sku: 'string', price: 'number' } } } });
    const v2 = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/versions`, headers: auth, payload: { reason: 'second' } });
    const diff = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/versions/1/compare/2`, headers: auth }); expect(diff.statusCode).toBe(200); expect(diff.json().changedFiles).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/versions`, headers: otherAuth })).statusCode).toBe(404);
    const rollback = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/versions/1/rollback`, headers: auth }); expect(rollback.statusCode).toBe(200); expect(rollback.json().version).toBe(3);
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/products`, headers: auth })).json().products[0].id).toBe(product.json().id);
    await access(join(dir, 'projects', id, '.git'));
  });

  it('versions specifications and records deployment metadata', async () => {
    const auth = { authorization: `Bearer ${await register('deploy@example.com')}` }; const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Deploy' } }); const id = p.json().id;
    const spec = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: { Product: { sku: 'string' } } } }); expect(spec.json().version).toBe(1);
    const dep = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/deployments`, headers: auth, payload: { environment: 'preview', version: 1 } }); expect(dep.statusCode).toBe(200);
    expect(dep.json().url).toContain(`/preview/${id}`);
    const preview = await app.inject({ method: 'GET', url: `/preview/${id}`, headers: auth }); expect(preview.statusCode).toBe(200); expect(preview.headers['content-type']).toContain('text/html'); expect(preview.body).toContain('Deploy');
    const published = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/publish`, headers: auth, payload: { version: 1 } }); expect(published.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/audit-logs`, headers: auth })).json().logs.length).toBeGreaterThan(0);
  });
});

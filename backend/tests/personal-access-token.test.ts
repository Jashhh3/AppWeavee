import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server.js';

describe('personal access tokens', () => {
  let app: any; let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'appweave-pat-')); app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'test-secret', encryptionKey: 'test-encryption-key' }); });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  async function register(email: string) { const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'correct horse battery staple' } }); return response.json().token; }
  it('creates once-display tokens, lists metadata, authenticates MCP, revokes, and isolates ownership', async () => {
    const owner = await register('pat-owner@example.com'); const other = await register('pat-other@example.com');
    const created = await app.inject({ method: 'POST', url: '/api/v1/auth/tokens', headers: { authorization: `Bearer ${owner}` }, payload: {} });
    expect(created.statusCode).toBe(201); const raw = created.json().token; expect(raw).toMatch(/^aw_pat_/);
    expect(JSON.stringify(created.json())).toContain(raw);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/auth/tokens', headers: { authorization: `Bearer ${owner}` } });
    expect(listed.statusCode).toBe(200); expect(listed.json().tokens[0]).toMatchObject({ id: created.json().id, prefix: created.json().prefix, last4: created.json().last4 }); expect(JSON.stringify(listed.json())).not.toContain(raw);
    const db = JSON.parse(await readFile(join(dir, 'db.json'), 'utf8')); expect(db.personalAccessTokens[0].tokenHash).toBeTruthy(); expect(JSON.stringify(db)).not.toContain(raw);
    const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${raw}` }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize' } }); expect(mcp.statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/auth/tokens/${created.json().id}`, headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/auth/tokens/${created.json().id}`, headers: { authorization: `Bearer ${owner}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${raw}` }, payload: { jsonrpc: '2.0', id: 2, method: 'initialize' } })).statusCode).toBe(401);
  });
});

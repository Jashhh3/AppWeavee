import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';

describe('local MCP test authentication mode', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;
  afterEach(async () => { await app?.close(); if (dir) await rm(dir, { recursive: true, force: true }); app = undefined; dir = undefined; });
  async function start(options: { mcpLocalTestMode?: boolean } = {}) {
    dir = await mkdtemp(join(tmpdir(), 'appweave-mcp-auth-'));
    app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'test-secret', encryptionKey: 'test-encryption-key', ...options });
    return app;
  }
  const initialize = () => app!.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'initialize' } });

  it('keeps MCP authentication required by default', async () => {
    await start();
    const response = await initialize();
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(-32001);
  });

  it('allows unauthenticated MCP requests with the explicit local test flag', async () => {
    await start({ mcpLocalTestMode: true });
    expect((await initialize()).statusCode).toBe(200);
    const created = await app!.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'Local connector test' } } } });
    expect(created.statusCode).toBe(200);
    expect(created.json().result.structuredContent.name).toBe('Local connector test');
  });

  it('shows local MCP-created projects in the authenticated dashboard during development', async () => {
    await start({ mcpLocalTestMode: true });
    const registered = await app!.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'dashboard@example.com', password: 'password-123' } });
    const created = await app!.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'Visible connector project' } } } });
    const listed = await app!.inject({ method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${registered.json().token}` } });
    expect(created.statusCode).toBe(200);
    expect(listed.json().projects).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Visible connector project' })]));
  });

  it('ignores the flag in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await start({ mcpLocalTestMode: true }); } finally { process.env.NODE_ENV = previous; }
    const response = await initialize();
    expect(response.statusCode).toBe(401);
  });
});

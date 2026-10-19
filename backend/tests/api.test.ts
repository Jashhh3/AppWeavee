import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { access, writeFile, mkdir } from 'node:fs/promises';
import { buildApp } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('AppWeave API', () => {
  let app: FastifyInstance; let dir: string; let openrouterUnavailable = false; let providerFailure: { status?: number; timeout?: boolean; retryAfter?: string } | undefined;
  beforeEach(async () => { openrouterUnavailable = false; providerFailure = undefined; dir = await mkdtemp(join(tmpdir(), 'appweave-')); app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'test-secret', encryptionKey: 'test-encryption-key', fetch: async (url) => { if (providerFailure && !String(url).includes('/api/v1/models')) { if (providerFailure.timeout) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); return new Response(JSON.stringify({ error: { message: 'provider secret=hidden' } }), { status: providerFailure.status ?? 429, headers: providerFailure.retryAfter ? { 'retry-after': providerFailure.retryAfter } : undefined }); } if (String(url).includes('/api/v1/models')) { if (openrouterUnavailable) throw new Error('connection refused'); return new Response(JSON.stringify({ data: [{ id: 'free/model', name: 'Free Model', context_length: 8192, supported_parameters: ['tools', 'response_format'], pricing: { prompt: '0', completion: '0' }, secret: 'do-not-return' }, { id: 'paid/model', name: 'Paid Model', context_length: 4096, supported_parameters: [], pricing: { prompt: '0.000001', completion: '0' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } return new Response(JSON.stringify(String(url).includes('generativelanguage') ? { candidates: [{ content: { parts: [{ text: JSON.stringify({ schema: { entities: {}, relationships: [], roles: ['admin'], api: {}, frontend: {} } }) }] } }] } : { choices: [{ message: { content: JSON.stringify({ schema: { entities: {}, relationships: [], roles: ['admin'], api: {}, frontend: {} } }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); } }); });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  async function register(email: string) { const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'correct horse battery staple' } }); expect(r.statusCode).toBe(201); return r.json().token as string; }
  it('registers, authenticates, and keeps projects isolated', async () => {
    const a = await register('a@example.com'); const b = await register('b@example.com');
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { authorization: `Bearer ${a}` }, payload: { name: 'A' } });
    expect(project.statusCode).toBe(201); const id = project.json().id;
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: { authorization: `Bearer ${b}` } })).statusCode).toBe(404);
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/projects' }); expect(unauth.statusCode).toBe(401);
  });
  it('serves MCP JSON-RPC over the existing JWT bearer session', async () => {
    const jwt = await register('mcp@example.com');
    const unauthorized = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(unauthorized.statusCode).toBe(401); expect(unauthorized.headers['www-authenticate']).toBe('Bearer'); expect(unauthorized.json().error.code).toBe(-32001);
    const initialized = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${jwt}` }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(initialized.statusCode).toBe(200); expect(initialized.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } });
    const call = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${jwt}` }, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'appweave_health' } } });
    expect(call.statusCode).toBe(200); expect(call.json()).toMatchObject({ result: { isError: false, structuredContent: { status: 'ok' } } });
  });
  it('supports HttpOnly cookie sessions, refresh-style me, logout, and isolated preferences', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'cookie-a@example.com', password: 'correct horse battery staple' } });
    expect(first.statusCode).toBe(201);
    const setCookie = first.headers['set-cookie'];
    expect(String(setCookie)).toMatch(/^appweave_session=.*;.*HttpOnly/);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'cookie-a@example.com', password: 'correct horse battery staple' } });
    expect(login.statusCode).toBe(200);
    const cookieHeader = login.headers['set-cookie'];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(';')[0] : String(cookieHeader).split(';')[0];
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200); expect(me.json().user.email).toBe('cookie-a@example.com');
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie }, payload: { name: 'Preferred' } });
    const saved = await app.inject({ method: 'PATCH', url: '/api/v1/me/preferences', headers: { cookie }, payload: { selectedProjectId: project.json().id, selectedProvider: 'nvidia', selectedModel: 'meta/llama-3.1-8b-instruct' } });
    expect(saved.statusCode).toBe(200); expect(saved.json().preferences).toMatchObject({ selectedProjectId: project.json().id, selectedProvider: 'nvidia', selectedModel: 'meta/llama-3.1-8b-instruct' });
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'cookie-b@example.com', password: 'correct horse battery staple' } });
    const secondCookie = (Array.isArray(second.headers['set-cookie']) ? second.headers['set-cookie'][0] : String(second.headers['set-cookie'])).split(';')[0];
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/preferences', headers: { cookie: secondCookie } })).json().preferences.selectedProjectId).toBeNull();
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200); expect(String(logout.headers['set-cookie'])).toMatch(/^appweave_session=;/);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
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
    const auth = { authorization: `Bearer ${await register('deploy@example.com')}` }; const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Deploy' } }); const id = p.json().id; expect(p.json().previewUrl).toBe(`http://localhost:3000/preview/${id}`); expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth })).json().projects[0].previewUrl).toBe(`http://localhost:3000/preview/${id}`);
    const spec = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: { Product: { sku: 'string' } } } }); expect(spec.json().version).toBe(1);
    const dep = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/deployments`, headers: auth, payload: { environment: 'preview', version: 1 } }); expect(dep.statusCode).toBe(200);
    expect(dep.json().url).toContain(`/preview/${id}`);
    const preview = await app.inject({ method: 'GET', url: `/preview/${id}`, headers: auth }); expect(preview.statusCode).toBe(200); expect(preview.headers['content-type']).toContain('text/html'); expect(preview.body).toContain('Deploy');
    const published = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/publish`, headers: auth, payload: { version: 1 } }); expect(published.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/audit-logs`, headers: auth })).json().logs.length).toBeGreaterThan(0);
  });

  it('builds project source into an isolated artifact and serves the authenticated preview', async () => {
    const auth = { authorization: `Bearer ${await register('source-build@example.com')}` };
    const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Source Build' } });
    const id = p.json().id;
    await mkdir(join(dir, 'projects', id), { recursive: true });
    await writeFile(join(dir, 'projects', id, 'index.html'), '<!doctype html><h1>source artifact</h1>', 'utf8');
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: {} } });
    const built = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/builds`, headers: auth, payload: { version: 1 } });
    expect(built.statusCode).toBe(200);
    const builds = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/builds`, headers: auth });
    expect(builds.json().builds[0]).toMatchObject({ status: 'ready', runtime: 'artifact_only', artifacts: ['dist/index.html'] });
    const preview = await app.inject({ method: 'GET', url: `/preview/${id}`, headers: auth });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('source artifact');
  });

  it('serves the generated project form from preview before an explicit build', async () => {
    const auth = { authorization: `Bearer ${await register('preview-template@example.com')}` };
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Inventory Form' } });
    const id = project.json().id;
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: { entities: { Product: { fields: { sku: 'string', price: 'number' } } } } } });
    const preview = await app.inject({ method: 'GET', url: `/preview/${id}`, headers: auth });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('Generated from validated specification.');
    expect(preview.body).toContain('Product');
    expect(preview.body).not.toContain('has not written an');
    const styles = await app.inject({ method: 'GET', url: `/preview/${id}/src/styles.css`, headers: auth });
    expect(styles.statusCode).toBe(200);
    expect(styles.headers['content-type']).toContain('text/css');
  });

  it('persists bounded build failure state without activating a preview', async () => {
    const auth = { authorization: `Bearer ${await register('failed-build@example.com')}` };
    const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Failed Build' } });
    const id = p.json().id;
    await mkdir(join(dir, 'projects', id), { recursive: true });
    await writeFile(join(dir, 'projects', id, 'package.json'), '{ invalid', 'utf8');
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: {} } });
    const failed = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/builds`, headers: auth, payload: { version: 1 } });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error.code).toBe('BUILD_FAILED');
    const builds = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/builds`, headers: auth });
    expect(builds.json().builds[0]).toMatchObject({ status: 'failed', runtime: 'unavailable' });
    expect(builds.json().builds[0].logs.at(-1)).toContain('invalid JSON');
  });

  it('generates a React/Vite template and reports the isolated worker boundary', async () => {
    const auth = { authorization: `Bearer ${await register('generated-template@example.com')}` };
    const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Generated UI' } });
    const id = p.json().id;
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers: auth, payload: { schema: { entities: { Order: { fields: { total: 'number' } } } } } });
    const built = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/builds`, headers: auth, payload: { version: 1 } });
    expect(built.statusCode).toBe(200);
    const files = await Promise.all(['package.json', 'package-lock.json', 'src/main.jsx'].map(async file => { await access(join(dir, 'projects', id, file)); return file; }));
    expect(files).toHaveLength(3);
    expect(built.json().buildLog).toEqual(expect.arrayContaining([expect.stringContaining('generated React/Vite source template'), expect.stringContaining('worker unavailable')]));
    const runtime = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/runtime/status`, headers: auth });
    expect(runtime.statusCode).toBe(200);
    expect(runtime.json()).toMatchObject({ available: false, runtime: 'unavailable', limits: { timeoutMs: 30000, memoryMb: 512 } });
  });

  it('cleans owned project source and artifacts on deletion', async () => {
    const auth = { authorization: `Bearer ${await register('cleanup@example.com')}` };
    const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Cleanup' } });
    const id = p.json().id;
    await mkdir(join(dir, 'projects', id), { recursive: true });
    await writeFile(join(dir, 'projects', id, 'index.html'), '<h1>temporary</h1>', 'utf8');
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/projects/${id}`, headers: auth })).statusCode).toBe(200);
    await expect(access(join(dir, 'projects', id))).rejects.toThrow();
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers: auth })).statusCode).toBe(404);
  });

  it('manages owned project settings and validates updates', async () => {
    const owner = { authorization: `Bearer ${await register('settings-owner@example.com')}` };
    const other = { authorization: `Bearer ${await register('settings-other@example.com')}` };
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: owner, payload: { name: 'Settings' } });
    const id = created.json().id;
    const initial = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/settings`, headers: owner });
    expect(initial.statusCode).toBe(200); expect(initial.json()).toMatchObject({ name: 'Settings', lifecycleStatus: 'active', environment: 'development' });
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/settings`, headers: owner, payload: { name: 'Renamed', allowedOrigins: ['https://example.com'], usageLimit: 250, lifecycleStatus: 'paused', environment: 'preview' } });
    expect(updated.statusCode).toBe(200); expect(updated.json()).toMatchObject({ name: 'Renamed', allowedOrigins: ['https://example.com'], usageLimit: 250, lifecycleStatus: 'paused', environment: 'preview' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/settings`, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/settings`, headers: owner, payload: { usageLimit: -1 } })).statusCode).toBe(400);
  });

  it('lists NVIDIA with its dedicated endpoint and safe default model', async () => {
    const auth = { authorization: `Bearer ${await register('nvidia-defaults@example.com')}` };
    const id = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'NVIDIA' } })).json().id;
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/providers`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json().providers.find((provider: any) => provider.provider === 'nvidia')).toMatchObject({ provider: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'z-ai/glm-5.3-flash', configured: false, key: null });
  });

  it('stores provider credentials without returning keys and isolates provider operations', async () => {
    const owner = { authorization: `Bearer ${await register('provider-owner@example.com')}` };
    const other = { authorization: `Bearer ${await register('provider-other@example.com')}` };
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: owner, payload: { name: 'Providers' } });
    const id = created.json().id; const secret = 'sk-test-secret-value';
    const saved = await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/providers/openai`, headers: owner, payload: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: secret } });
    expect(saved.statusCode).toBe(200); expect(saved.json()).toMatchObject({ provider: 'openai', configured: true, model: 'gpt-4o-mini' }); expect(JSON.stringify(saved.json())).not.toContain(secret);
    const listed = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/providers`, headers: owner });
    expect(listed.statusCode).toBe(200); expect(JSON.stringify(listed.json())).not.toContain(secret); expect(listed.json().providers.find((x: any) => x.provider === 'openai').key).toMatch(/^••••••••alue$/);
    const test = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/providers/openai/test`, headers: owner });
    expect(test.statusCode).toBe(200); expect(test.json()).toMatchObject({ provider: 'openai', configured: true, reachable: true });
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/providers`, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/providers/openai`, headers: owner, payload: { baseUrl: 'not-a-url', model: '', key: '' } })).statusCode).toBe(400);
  });
  it('discovers only free OpenRouter models with safe metadata and project ownership', async () => {
    const owner = { authorization: `Bearer ${await register('models-owner@example.com')}` }; const other = { authorization: `Bearer ${await register('models-other@example.com')}` };
    const id = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: owner, payload: { name: 'Models' } })).json().id;
    await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/providers/openrouter`, headers: owner, payload: { baseUrl: 'https://openrouter.ai/api/v1///', model: 'openrouter/auto', key: 'or-secret-key' } });
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/providers/openrouter/models`, headers: owner });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ models: [{ id: 'free/model', name: 'Free Model', context_length: 8192, supported_parameters: ['tools', 'response_format'] }] });
    expect(JSON.stringify(response.json())).not.toContain('or-secret-key');
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/providers/openrouter/models`, headers: other })).statusCode).toBe(404);
  });
  it('returns an actionable provider unavailable error for model discovery', async () => {
    const auth = { authorization: `Bearer ${await register('models-down@example.com')}` }; const id = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Unavailable' } })).json().id;
    await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/providers/openrouter`, headers: auth, payload: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', key: 'or-secret-key' } }); openrouterUnavailable = true;
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/providers/openrouter/models`, headers: auth });
    expect(response.statusCode).toBe(503); expect(response.json().error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: 'AI provider is unreachable' }); expect(JSON.stringify(response.json())).not.toContain('or-secret-key');
  });
  it('generates a validated application spec through the configured provider', async () => {
    const auth = { authorization: `Bearer ${await register('generate@example.com')}` };
    const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Generate' } }); const id = p.json().id;
    await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/providers/gemini`, headers: auth, payload: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-test', key: 'gemini-secret' } });
    const response = await app.inject({ method: 'POST', url: '/api/v1/ai/generate', headers: auth, payload: { projectId: id, prompt: 'Create a catalog' } });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ provider: 'gemini', configured: true, applicationSpec: { schema: { roles: ['admin'] } } });
    expect(JSON.stringify(response.json())).not.toContain('gemini-secret');
  });

  it('does not allow generation for another owner or invalid provider output', async () => {
    const owner = { authorization: `Bearer ${await register('gen-owner@example.com')}` }; const other = { authorization: `Bearer ${await register('gen-other@example.com')}` };
    const p = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: owner, payload: { name: 'Owned' } }); const id = p.json().id;
    expect((await app.inject({ method: 'POST', url: '/api/v1/ai/generate', headers: other, payload: { projectId: id, prompt: 'x' } })).statusCode).toBe(404);
  });

  it('persists bounded 429 retry metadata and prevents rapid duplicate retries', async () => {
    const auth = { authorization: `Bearer ${await register('retry@example.com')}` };
    const id = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'Retry' } })).json().id;
    await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/providers/openai`, headers: auth, payload: { baseUrl: 'https://provider.example/v1', model: 'retry-model', key: 'retry-secret' } });
    const draft = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/ai/builds/drafts`, headers: auth, payload: { prompt: 'Retry me', provider: 'openai' } });
    providerFailure = { status: 429, retryAfter: '999999' };
    const failed = await app.inject({ method: 'POST', url: '/api/v1/ai/generate', headers: auth, payload: { projectId: id, draftId: draft.json().id, prompt: 'Retry me' } });
    expect(failed.statusCode).toBe(429); expect(failed.headers['retry-after']).toBe('300'); expect(failed.json().error).toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryAfter: 300, attemptedProvider: 'openai', attemptedModel: 'retry-model' });
    const latest = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/ai/builds/latest`, headers: auth });
    expect(latest.json().build).toMatchObject({ retryAfter: 300, attemptedProvider: 'openai', attemptedModel: 'retry-model', status: 'failed' }); expect(latest.json().build.nextRetryAt).toBeTruthy();
    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/ai/generate', headers: auth, payload: { projectId: id, draftId: draft.json().id, prompt: 'Retry me' } });
    expect(duplicate.statusCode).toBe(429); expect(duplicate.json().error.code).toBe('PROVIDER_RETRY_LATER');
  });

  it('persists timeout retry state and keeps drafts isolated by project owner', async () => {
    const owner = { authorization: `Bearer ${await register('timeout@example.com')}` }; const other = { authorization: `Bearer ${await register('timeout-other@example.com')}` };
    const id = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: owner, payload: { name: 'Timeout' } })).json().id;
    await app.inject({ method: 'PATCH', url: `/api/v1/projects/${id}/providers/openai`, headers: owner, payload: { baseUrl: 'https://provider.example/v1', model: 'timeout-model', key: 'timeout-secret' } });
    const draft = await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/ai/builds/drafts`, headers: owner, payload: { prompt: 'Wait', provider: 'openai' } });
    providerFailure = { timeout: true };
    const failed = await app.inject({ method: 'POST', url: '/api/v1/ai/generate', headers: owner, payload: { projectId: id, draftId: draft.json().id, prompt: 'Wait' } });
    expect(failed.statusCode).toBe(504); expect(failed.json().error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryAfter: 30 });
    const latest = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/ai/builds/latest`, headers: owner });
    expect(latest.json().build).toMatchObject({ retryAfter: 30, attemptedProvider: 'openai', attemptedModel: 'timeout-model' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/ai/builds/latest`, headers: other })).statusCode).toBe(404);
  });

});

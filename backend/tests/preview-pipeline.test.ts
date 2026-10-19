import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';
import { runSandboxedViteBuild } from '../src/sandbox-worker.js';
import { syncPreviewEntryPoint } from '../src/project-runtime.js';

vi.mock('../src/sandbox-worker.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sandbox-worker.js')>(),
  runSandboxedViteBuild: vi.fn(),
}));
const worker = vi.mocked(runSandboxedViteBuild);

describe('shared preview artifact pipeline', () => {
  let dir: string;
  let root: string;
  let app: FastifyInstance;
  let id: string;
  let headers: { authorization: string };
  const outputHtml = '<!doctype html><html><head><script type="module" src="./assets/nested/app-a1.js"></script><link rel="stylesheet" href="/assets/app-a1.css"></head><body><div id="root">real compiled output</div></body></html>';
  beforeEach(async () => {
    worker.mockReset();
    dir = await mkdtemp(join(tmpdir(), 'appweave-preview-'));
    app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'test-preview', encryptionKey: 'test-preview-encryption' });
    const user = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'preview@example.com', password: 'correct horse battery staple' } });
    headers = { authorization: `Bearer ${user.json().token}` };
    id = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Vite preview' } })).json().id;
    root = join(dir, 'projects', id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    await writeFile(join(root, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/src/main.jsx"></script>');
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers, payload: { schema: {} } });
  });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const ready = () => worker.mockImplementation(async (_root, out) => {
    await mkdir(join(out, 'assets/nested'), { recursive: true });
    await writeFile(join(out, 'index.html'), outputHtml);
    await writeFile(join(out, 'assets/nested/app-a1.js'), 'console.log("compiled Vite");');
    await writeFile(join(out, 'assets/app-a1.css'), 'body{color:green}');
    return { status: 'ready', runtime: 'docker_worker', logs: ['vite build completed'] };
  });
  const build = () => app.inject({ method: 'POST', url: `/api/v1/projects/${id}/builds`, headers, payload: { version: 1 } });
  const get = (path = '') => app.inject({ method: 'GET', url: `/preview/${id}${path}`, headers });

  it('promotes validated Vite dist, serves nested assets, and returns 404 for absent assets and source JSX', async () => {
    ready();
    expect((await build()).statusCode).toBe(200);
    expect(await readFile(join(root, 'preview/version-1/dist/index.html'), 'utf8')).toBe(outputHtml);
    const page = await get();
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`<base href="/preview/${id}/">`);
    expect(page.body).toContain(`href="/preview/${id}/assets/app-a1.css"`);
    expect(page.body).not.toContain('/src/main.jsx');
    const asset = await get('/assets/nested/app-a1.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.body).toContain('compiled Vite');
    expect((await get('/assets/app-a1.css')).statusCode).toBe(200);
    expect((await get('/assets/missing.js')).statusCode).toBe(404);
    expect((await get('/src/main.jsx')).statusCode).toBe(404);
    await writeFile(join(root, 'secret.js'), 'must not leak');
    await symlink(join(root, 'secret.js'), join(root, 'preview/version-1/dist/leak.js'));
    expect((await get('/leak.js')).statusCode).toBe(404);
    expect((await get('/assets/%2e%2e/%2e%2e/index.html')).statusCode).toBe(404);
  });

  it('serves a locked pre-built artifact without invoking the Docker compiler', async () => {
    await writeFile(join(root, 'package-lock.json'), '{}');
    await mkdir(join(root, 'dist/assets'), { recursive: true });
    await writeFile(join(root, 'dist/index.html'), '<!doctype html><html><body><main><h1>Pre-built app</h1><script type="module" src="./assets/app.js"></script></main></body></html>');
    await writeFile(join(root, 'dist/assets/app.js'), 'document.body.dataset.ready = "true";');
    worker.mockRejectedValue(new Error('Docker compiler must not run for a pre-built project'));
    const response = await build();
    expect(response.statusCode).toBe(200);
    const records = (await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/builds`, headers })).json();
    expect(records.builds[0].runtime).toBe('artifact_only');
    expect(await readFile(join(root, 'preview/version-1/dist/index.html'), 'utf8')).toContain('Pre-built app');
    expect((await get('/assets/app.js')).statusCode).toBe(200);
    expect(worker).not.toHaveBeenCalled();
  });

  it.each(['failed', 'unavailable'] as const)('records %s worker accurately without static React fallback', async status => {
    worker.mockResolvedValue({ status, runtime: status === 'failed' ? 'docker_worker' : 'unavailable', logs: ['build unavailable'], error: 'BUILD_REJECTED' });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist/index.html'), '<!doctype html><h1>stale static shell</h1>');
    expect((await build()).statusCode).toBe(422);
    const records = (await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/builds`, headers })).json();
    expect(records.builds[0]).toMatchObject({ status: 'failed', error: 'BUILD_REJECTED', artifacts: [] });
    expect(records.deployments[0].status).toBe('failed');
    expect((await get()).statusCode).toBe(422);
    expect((await get('/src/main.jsx')).statusCode).toBe(404);
  });

  it('rejects a worker success with missing Vite assets and preserves the same-version last good output', async () => {
    ready();
    expect((await build()).statusCode).toBe(200);
    await syncPreviewEntryPoint(root, 'index.html');
    expect(await readFile(join(root, 'preview/version-1/dist/index.html'), 'utf8')).toBe(outputHtml);
    worker.mockImplementation(async (_root, out) => {
      await writeFile(join(out, 'index.html'), '<!doctype html><script src="/assets/missing.js"></script>');
      return { status: 'ready', runtime: 'docker_worker', logs: [] };
    });
    expect((await build()).statusCode).toBe(422);
    expect((await get()).body).toContain('real compiled output');
    expect((await get('/assets/nested/app-a1.js')).statusCode).toBe(200);
    worker.mockResolvedValue({ status: 'failed', runtime: 'docker_worker', logs: [], error: 'SYNTAX_ERROR' });
    expect((await build()).statusCode).toBe(422);
    expect((await get()).body).toContain('real compiled output');
    // Never borrow an asset from an unrelated root dist.
    await mkdir(join(root, 'dist/assets'), { recursive: true });
    await writeFile(join(root, 'dist/assets/stale.js'), 'stale');
    expect((await get('/assets/stale.js')).statusCode).toBe(404);
  });

  it('rejects a successful worker exit without index.html instead of manufacturing a shell', async () => {
    worker.mockResolvedValue({ status: 'ready', runtime: 'docker_worker', logs: [] });
    expect((await build()).statusCode).toBe(422);
    const records = (await app.inject({ method: 'GET', url: `/api/v1/projects/${id}/builds`, headers })).json();
    expect(records.builds[0]).toMatchObject({ status: 'failed', artifacts: [] });
    expect(records.deployments.some((deployment: { status: string }) => deployment.status === 'active')).toBe(false);
  });

  it('retains existing static dist fallback with no package manifest and copies its real assets', async () => {
    await rm(join(root, 'package.json'));
    await rm(join(root, 'index.html'));
    await mkdir(join(root, 'dist/assets/nested'), { recursive: true });
    await writeFile(join(root, 'dist/index.html'), '<!doctype html><script src="/assets/nested/static.js"></script><h1>existing static</h1>');
    await writeFile(join(root, 'dist/assets/nested/static.js'), 'console.log("static")');
    expect((await get()).body).toContain('existing static');
    expect((await get('/assets/nested/static.js')).statusCode).toBe(200);
    expect((await build()).statusCode).toBe(200);
    expect(worker).not.toHaveBeenCalled();
    expect((await get('/assets/nested/static.js')).statusCode).toBe(200);
    expect((await get('/src/main.jsx')).statusCode).toBe(404);
  });

  it.each([undefined, 'SPA', 'static'])('does not enable extensionless SPA fallback for routing=%s', async routing => {
    ready();
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers, payload: { schema: { frontend: routing ? { routing } : {} } } });
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/builds`, headers, payload: { version: 2 } })).statusCode).toBe(200);
    expect((await get('/dashboard/reports')).statusCode).toBe(404);
  });

  it('uses explicitly enabled SPA routing and shared scoped HTML on nested preview routes, never missing assets', async () => {
    ready();
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers, payload: { schema: { frontend: { routing: 'spa' } } } });
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/builds`, headers, payload: { version: 2 } })).statusCode).toBe(200);
    const nested = await get('/dashboard/reports');
    expect(nested.statusCode).toBe(200);
    expect(nested.headers['content-type']).toContain('text/html');
    expect(nested.body).toBe((await get()).body);
    expect(nested.body).toContain(`<base href="/preview/${id}/">`);
    expect(nested.body).toContain(`href="/preview/${id}/assets/app-a1.css"`);
    expect((await get('/')).statusCode).toBe(200);
    expect((await get('/dashboard/reports/')).statusCode).toBe(200);
    for (const path of ['/assets/missing.js', '/src/main.jsx', '/dashboard/missing.css', '/assets/missing.js/nested']) expect((await get(path)).statusCode).toBe(404);
    // A newer unbuilt specification must not change the active build's routing.
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers, payload: { schema: { frontend: { routing: 'static' } } } });
    expect((await get('/dashboard/reports')).statusCode).toBe(200);
  });

  it('does not enable SPA routing on the current preview from a newer unbuilt specification', async () => {
    ready();
    expect((await build()).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers, payload: { schema: { frontend: { routing: 'spa' } } } });
    expect((await get('/dashboard/reports')).statusCode).toBe(404);
  });

  it('serves authenticated production dist and scoped assets from the configured workspace', async () => {
    ready();
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/publish`, headers, payload: { version: 1 } })).statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: `/app/${id}`, headers });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('real compiled output');
    expect(page.body).toContain(`<base href="/app/${id}/">`);
    expect(page.body).toContain(`href="/app/${id}/assets/app-a1.css"`);
    expect(page.body).not.toContain(`/preview/${id}/`);
    const asset = await app.inject({ method: 'GET', url: `/app/${id}/assets/nested/app-a1.js`, headers });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.body).toContain('compiled Vite');
    for (const path of ['', '/assets/nested/app-a1.js']) expect((await app.inject({ method: 'GET', url: `/app/${id}${path}` })).statusCode).toBe(401);
    const other = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'other-preview@example.com', password: 'correct horse battery staple' } });
    for (const path of ['', '/assets/nested/app-a1.js']) expect((await app.inject({ method: 'GET', url: `/app/${id}${path}`, headers: { authorization: `Bearer ${other.json().token}` } })).statusCode).toBe(404);
    for (const path of ['/assets/missing.js', '/src/main.jsx', '/dashboard/reports']) expect((await app.inject({ method: 'GET', url: `/app/${id}${path}`, headers })).statusCode).toBe(404);
  });

  it('shares SPA scoping in production while preserving the last successful publication after failure', async () => {
    ready();
    await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/specifications/versions`, headers, payload: { schema: { frontend: { routing: 'spa' } } } });
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/publish`, headers, payload: { version: 2 } })).statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: `/app/${id}/dashboard/reports`, headers });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`<base href="/app/${id}/">`);
    expect(page.body).toContain(`href="/app/${id}/assets/app-a1.css"`);
    for (const path of ['/assets/missing.js', '/src/main.jsx']) expect((await app.inject({ method: 'GET', url: `/app/${id}${path}`, headers })).statusCode).toBe(404);
    worker.mockResolvedValue({ status: 'failed', runtime: 'docker_worker', logs: [], error: 'BUILD_FAILED' });
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${id}/publish`, headers, payload: { version: 2 } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: `/app/${id}/dashboard/reports`, headers })).body).toBe(page.body);
  });
});

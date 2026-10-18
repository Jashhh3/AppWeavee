import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server.js';

describe('OAuth 2.1 PKCE connector', () => {
  let app: any; let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'appweave-oauth-')); app = await buildApp({ dataFile: join(dir, 'db.json'), workspaceRoot: join(dir, 'projects'), jwtSecret: 'oauth-test-secret', encryptionKey: 'oauth-test-encryption' }); });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  it('publishes metadata and registers a PKCE client', async () => {
    const metadata = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'connector.test' } });
    expect(metadata.statusCode).toBe(200); expect(metadata.json()).toMatchObject({ authorization_endpoint: 'http://connector.test/oauth/authorize', token_endpoint: 'http://connector.test/oauth/token', code_challenge_methods_supported: ['S256'] });
    const registered = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://chatgpt.com/callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
    expect(registered.statusCode).toBe(201); expect(registered.json()).toMatchObject({ token_endpoint_auth_method: 'none' }); expect(registered.json().client_secret).toBeUndefined();
  });
  it('authorizes a logged-in cookie, exchanges PKCE code, rejects replay/bad verifier, and accesses MCP', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'oauth@example.com', password: 'correct horse battery staple' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const client = (await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://chatgpt.com/callback'] } })).json();
    const verifier = randomBytes(32).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://chatgpt.com/callback', response_type: 'code', state: 'state-123', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp' });
    const consent = await app.inject({ method: 'GET', url: `/oauth/authorize?${query}`, headers: { cookie } }); expect(consent.statusCode).toBe(200); expect(consent.body).toContain('No password is collected');
    const approved = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `${query}&approve=true` });
    expect(approved.statusCode).toBe(302); const location = String(approved.headers.location); const code = new URL(location).searchParams.get('code'); expect(new URL(location).searchParams.get('state')).toBe('state-123'); expect(code).toBeTruthy();
    const invalidVerifier = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'https://chatgpt.com/callback', code_verifier: 'wrong-verifier' } }); expect(invalidVerifier.statusCode).toBe(400); expect(invalidVerifier.json().error).toBe('invalid_grant');
    const exchanged = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'https://chatgpt.com/callback', code_verifier: verifier } });
    expect(exchanged.statusCode).toBe(200); expect(exchanged.json()).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
    const access = exchanged.json().access_token;
    const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${access}` }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize' } }); expect(mcp.statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${access}` }, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'ChatGPT project' } } } });
    expect(created.statusCode).toBe(200); expect(created.json().result.structuredContent.previewUrl).toContain('/preview/');
    const dashboardProjects = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie } });
    expect(dashboardProjects.json().projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.json().result.structuredContent.id, name: 'ChatGPT project' })]));
    const replay = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'https://chatgpt.com/callback', code_verifier: verifier } }); expect(replay.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', client_id: client.client_id, code: 'not-a-code', redirect_uri: 'https://chatgpt.com/callback', code_verifier: 'wrong' } })).statusCode).toBe(400);
    const refreshed = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: exchanged.json().refresh_token } }); expect(refreshed.statusCode).toBe(200); expect(refreshed.json().access_token).toBeTruthy();
  });
});

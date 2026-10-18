import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import type { OAuthAuthorizationCode } from './types.js';
import { userId } from './auth.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => { const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex'); return x.length === y.length && timingSafeEqual(x, y); };
const base = (request: any) => (process.env.PUBLIC_BASE_URL ?? `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');
const params = (body: unknown) => typeof body === 'string' ? Object.fromEntries(new URLSearchParams(body)) : (body && typeof body === 'object' ? body as Record<string, unknown> : {});
const oauthError = (reply: any, error: string, description: string, status = 400) => reply.code(status).type('application/json').send({ error, error_description: description });
const validRedirect = (value: string) => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.hash; } catch { return false; } };
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));

export function registerOAuthRoutes(app: FastifyInstance, store: Store, secret: string, cookieName: string) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  const metadata = (request: any) => { const issuer = base(request); return { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'] }; };
  app.get('/.well-known/oauth-authorization-server', async request => metadata(request));
  app.get('/.well-known/openid-configuration', async request => metadata(request));
  app.get('/.well-known/oauth-protected-resource', async request => { const issuer = base(request); return { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'] }; });
  app.get('/.well-known/protected-resource', async request => { const issuer = base(request); return { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'] }; });
  app.get('/.well-known/oauth-protected-resource/mcp', async request => { const issuer = base(request); return { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'] }; });

  app.post('/oauth/register', async (request: any, reply) => {
    const body = params(request.body); const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.some(x => typeof x !== 'string' || !validRedirect(x))) return oauthError(reply, 'invalid_client_metadata', 'redirect_uris must contain valid absolute redirect URIs');
    const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code'];
    const responseTypes = Array.isArray(body.response_types) ? body.response_types : ['code'];
    if (!grantTypes.includes('authorization_code') || !responseTypes.includes('code')) return oauthError(reply, 'invalid_client_metadata', 'authorization_code and code are required');
    const method = body.token_endpoint_auth_method ?? 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(String(method))) return oauthError(reply, 'invalid_client_metadata', 'unsupported token endpoint authentication method');
    const clientId = `aw_client_${randomBytes(18).toString('base64url')}`; const createdAt = new Date().toISOString();
    const clientSecret = method === 'none' ? undefined : `aw_secret_${randomBytes(32).toString('base64url')}`;
    await store.commit(db => db.oauthClients.push({ id: store.id(), clientId, clientSecretHash: clientSecret ? sha(clientSecret) : undefined, redirectUris: redirectUris as string[], grantTypes: grantTypes as string[], responseTypes: responseTypes as string[], tokenEndpointAuthMethod: method as any, createdAt }));
    return reply.code(201).send({ client_id: clientId, client_secret: clientSecret, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirectUris, grant_types: grantTypes, response_types: responseTypes, token_endpoint_auth_method: method });
  });

  const authorize = async (request: any, reply: any) => {
    const q = { ...request.query as Record<string, unknown>, ...params(request.body) }; const clientId = String(q.client_id ?? ''), redirectUri = String(q.redirect_uri ?? ''), responseType = String(q.response_type ?? ''), challenge = String(q.code_challenge ?? ''), method = String(q.code_challenge_method ?? '');
    const client = store.data.oauthClients.find(x => x.clientId === clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) return oauthError(reply, 'invalid_request', 'Unknown client or redirect URI');
    if (responseType !== 'code' || method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return oauthError(reply, 'invalid_request', 'response_type=code and PKCE S256 are required');
    const state = typeof q.state === 'string' ? q.state : '';
    let uid: string;
    try { uid = userId(request, secret, cookieName, store); } catch { return reply.code(401).type('text/html').send('<!doctype html><title>AppWeave authorization</title><h1>Sign in required</h1><p>Sign in to AppWeave in this browser, then retry the connector authorization.</p>'); }
    if (request.method === 'GET' && q.approve !== 'true') {
      const hidden = ['client_id','redirect_uri','response_type','scope','state','code_challenge','code_challenge_method'].map(k => `<input type="hidden" name="${k}" value="${htmlEscape(String(q[k] ?? ''))}">`).join('');
      return reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Authorize AppWeave</title><h1>Authorize AppWeave</h1><p>You are signed in as <strong>${htmlEscape(store.data.users.find(x => x.id === uid)?.email ?? 'your AppWeave account')}</strong>.</p><p>This connector is requesting access to your AppWeave MCP tools. No password is collected here.</p><form method="post" action="/oauth/authorize">${hidden}<button name="approve" value="true" type="submit">Allow access</button></form>`);
    }
    if (String(q.approve) !== 'true') return oauthError(reply, 'access_denied', 'Authorization was not approved');
    const raw = `aw_code_${randomBytes(32).toString('base64url')}`; const now = Date.now(); const record: OAuthAuthorizationCode = { id: store.id(), codeHash: sha(raw), clientId, redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', userId: uid, scope: typeof q.scope === 'string' ? q.scope : undefined, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
    await store.commit(db => db.oauthAuthorizationCodes.push(record));
    const target = new URL(redirectUri); target.searchParams.set('code', raw); if (state) target.searchParams.set('state', state);
    return reply.redirect(target.toString());
  };
  app.get('/oauth/authorize', authorize); app.post('/oauth/authorize', authorize);

  app.post('/oauth/token', async (request: any, reply) => {
    const body = params(request.body); let clientId = String(body.client_id ?? ''), clientSecret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
    const auth = request.headers.authorization as string | undefined;
    if (auth?.startsWith('Basic ')) { try { const decoded = Buffer.from(auth.slice(6), 'base64').toString(); const i = decoded.indexOf(':'); clientId = decodeURIComponent(decoded.slice(0, i)); clientSecret = decodeURIComponent(decoded.slice(i + 1)); } catch { return oauthError(reply, 'invalid_client', 'Invalid client authentication', 401); } }
    const client = store.data.oauthClients.find(x => x.clientId === clientId); if (!client) return oauthError(reply, 'invalid_client', 'Unknown client', 401);
    if (client.tokenEndpointAuthMethod !== 'none' && (!clientSecret || !client.clientSecretHash || !equal(sha(clientSecret), client.clientSecretHash))) return oauthError(reply, 'invalid_client', 'Invalid client authentication', 401);
    const grant = String(body.grant_type ?? '');
    if (grant === 'authorization_code') {
      const raw = String(body.code ?? ''), redirectUri = String(body.redirect_uri ?? ''), verifier = String(body.code_verifier ?? ''); const record = store.data.oauthAuthorizationCodes.find(x => equal(x.codeHash, sha(raw)));
      if (!record || record.clientId !== clientId || record.redirectUri !== redirectUri || record.usedAt || Date.parse(record.expiresAt) <= Date.now() || !record.userId) return oauthError(reply, 'invalid_grant', 'Invalid, expired, or already-used authorization code');
      const expected = createHash('sha256').update(verifier).digest('base64url'); if (!verifier || !equal(sha(expected), sha(record.codeChallenge))) return oauthError(reply, 'invalid_grant', 'PKCE verifier is invalid');
      record.usedAt = new Date().toISOString();
      const refreshToken = `aw_refresh_${randomBytes(32).toString('base64url')}`;
      await store.commit(db => { db.oauthAuthorizationCodes; db.oauthRefreshTokens.push({ id: store.id(), tokenHash: sha(refreshToken), clientId, userId: record.userId!, scope: record.scope, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }); });
      const accessToken = jwt.sign({ sub: record.userId, scope: record.scope, token_use: 'oauth' }, secret, { expiresIn: '5m', audience: `${base(request)}/mcp` });
      return reply.send({ access_token: accessToken, token_type: 'Bearer', expires_in: 300, refresh_token: refreshToken, scope: record.scope });
    }
    if (grant === 'refresh_token') {
      const raw = String(body.refresh_token ?? ''), record = store.data.oauthRefreshTokens.find(x => equal(x.tokenHash, sha(raw)) && x.clientId === clientId && !x.revokedAt && Date.parse(x.expiresAt) > Date.now());
      if (!record) return oauthError(reply, 'invalid_grant', 'Invalid or expired refresh token');
      const accessToken = jwt.sign({ sub: record.userId, scope: record.scope, token_use: 'oauth' }, secret, { expiresIn: '5m', audience: `${base(request)}/mcp` }); return reply.send({ access_token: accessToken, token_type: 'Bearer', expires_in: 300, refresh_token: raw, scope: record.scope });
    }
    return oauthError(reply, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
  });
}

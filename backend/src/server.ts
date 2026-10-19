import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { Store } from './store.js';
import { hash, verify, token, userId, ownedProject, ownedProjects } from './auth.js';
import type { Project, Product, Deployment, UserPreferences, AIBuildDraft, ProjectBuild, SurveyResponse } from './types.js';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_AI_PROVIDER_TIMEOUT_MS, DEFAULT_PROVIDER_RETRY_AFTER_SECONDS, decryptProviderKey, encryptProviderKey, HttpAIProvider, resolveAIProviderTimeoutMs } from './ai.js';
import { ProjectVersionRepo, type VersionFiles } from './versions.js';
import type { Snapshot, AIProviderName, AIProviderConfig, ProjectSettings } from './types.js';
import { normalizeApplicationSpec, parseProviderSpec } from './application-spec.js';
import { registerMcpRoutes } from './mcp.js';
import { registerOAuthRoutes } from './oauth.js';
import { buildProjectArtifacts, validateArtifact } from './project-runtime.js';
import { stat } from 'node:fs/promises';
import { readArtifactResponse } from './artifact-serving.js';
import { sandboxStatus } from './sandbox-worker.js';
import { ProjectDatabaseManager } from './project-database.js';
import { ensureProjectStorage, projectRoot, requireProjectStorage, workspaceRootPath } from './project-storage.js';

const productInput = z.object({ name: z.string().trim().min(1).max(200), sku: z.string().trim().min(1).max(80), price: z.number().finite().nonnegative(), description: z.string().max(2000).optional() });
const specInput = z.object({ schema: z.object({ entities: z.record(z.object({ fields: z.record(z.string()), permissions: z.record(z.array(z.string())).optional() })).default({}), relationships: z.array(z.record(z.string())).default([]), roles: z.array(z.string()).default(['admin']), api: z.record(z.unknown()).default({}), frontend: z.record(z.unknown()).default({}) }) });
const idParam = z.object({ projectId: z.string().uuid() });
const now = () => new Date().toISOString();
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
const bad = (message: string, statusCode = 400, code = 'BAD_REQUEST') => Object.assign(new Error(message), { statusCode, code });
const settingsInput = z.object({ name: z.string().trim().min(1).max(200).optional(), allowedOrigins: z.array(z.string().url().max(2048)).max(50).optional(), usageLimit: z.number().int().nonnegative().max(10_000_000).optional(), lifecycleStatus: z.enum(['active', 'paused', 'archived']).optional(), environment: z.enum(['development', 'preview', 'production']).optional() }).strict();
const providerParam = z.object({ provider: z.enum(['gemini', 'openai', 'openrouter', 'groq', 'nvidia']) });
const providerInput = z.object({ baseUrl: z.string().url().max(2048), model: z.string().trim().min(1).max(200), key: z.string().min(1).max(4096).optional(), apiKey: z.string().min(1).max(4096).optional() }).strict().refine(input => Boolean(input.key ?? input.apiKey), { message: 'A provider key is required', path: ['key'] });
const providerDefaults: Record<AIProviderName, { baseUrl: string; model: string }> = { gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest' }, openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' }, groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'qwen/qwen3.8-27b' }, nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'z-ai/glm-5.3-flash' } };
const draftInput = z.object({ prompt: z.string().trim().min(1).max(4000), fields: z.record(z.unknown()).default({}), provider: providerParam.shape.provider.default('openai'), model: z.string().trim().min(1).max(200).optional() }).strict();
const safePrompt = (value: string) => redact(value).slice(0, 4000);
const sanitizeFields = (value: unknown): Record<string, unknown> => {
  const clean = (item: unknown): unknown => { if (typeof item === 'string') return safePrompt(item); if (Array.isArray(item)) return item.slice(0, 100).map(clean); if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item as Record<string, unknown>).slice(0, 100).map(([key, child]) => [key, /key|token|secret|password/i.test(key) ? '[redacted]' : clean(child)])); return item; };
  return (clean(value) as Record<string, unknown>) ?? {};
};
const preferencesInput = z.object({ selectedProjectId: z.string().uuid().nullable().optional(), selectedProvider: z.enum(['gemini', 'openai', 'openrouter', 'groq', 'nvidia']).nullable().optional(), selectedModel: z.string().trim().min(1).max(200).nullable().optional() }).strict();
const surveyResponseInput = z.object({ surveyId: z.string().trim().min(1).max(100).optional(), answers: z.record(z.unknown()).refine(value => Object.keys(value).length <= 100, 'Survey answers contain too many fields'), consent: z.literal(true, { errorMap: () => ({ message: 'Consent is required' }) }) }).strict();
const publicSurveyResponseInput = surveyResponseInput.extend({ projectId: z.string().uuid().optional(), publicClientId: z.string().trim().min(1).max(200).optional() }).refine(value => Boolean(value.projectId || value.publicClientId), { message: 'A projectId or publicClientId is required', path: ['projectId'] });
const surveyResponseMaxBytes = 64 * 1024;
const databaseTestInput = z.object({ projectId: z.string().uuid(), fullName: z.string().trim().min(1).max(200), email: z.string().email().max(320), phone: z.string().trim().min(1).max(50), city: z.string().trim().min(1).max(120), testMessage: z.string().trim().min(1).max(4000) }).strict();
const mcpTokenView = (item: any) => ({ id: item.id, name: item.name, tokenPrefix: item.tokenPrefix, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt ?? null, revokedAt: item.revokedAt ?? null, status: item.revokedAt ? 'revoked' : 'active' });
  const providerView = (c: AIProviderConfig) => ({ provider: c.provider, baseUrl: c.baseUrl, model: c.model, configured: Boolean(c.keyConfigured && c.keyCiphertext), key: c.keyConfigured && c.keyCiphertext ? `••••••••${c.keyLast4 ?? ''}` : null, updatedAt: c.updatedAt });
const redact = (value: string, secrets: string[] = []) => { let result = value.replace(/(?:api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;}]+/gi, '$1: [redacted]'); for (const secret of secrets.filter(x => x.length > 3)) result = result.split(secret).join('[redacted]'); return result; };
const appVersion = process.env.APP_VERSION ?? '1.0.0';
const publicBaseUrl = () => (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const previewUrl = (projectId: string) => `${publicBaseUrl()}/preview/${projectId}`;
const aiFailure = (stage: string, requestId: string, cause: unknown, diagnostics: unknown[] = []) => { const source = cause as any; const provider = String(source?.code ?? '').startsWith('PROVIDER_'); const sourceDiagnostic = source?.code || source?.message ? [{ code: String(source?.code ?? 'generation_failed'), message: redact(String(source?.message ?? 'The AI generation pipeline failed before producing a result.')).slice(0, 300), provider: source?.provider, model: source?.model, retryAfter: source?.retryAfter }] : []; const safeDiagnostics = diagnostics.length || source?.diagnostics?.length || sourceDiagnostic.length ? [...diagnostics, ...(source?.diagnostics ?? []), ...sourceDiagnostic] : [{ code: stage === 'persist_context' ? 'persistence_failed' : 'generation_failed', message: stage === 'persist_context' ? 'The generated specification could not be saved. Retry the request and check server storage.' : 'The AI generation pipeline failed before producing a result. Retry the request.' }]; return Object.assign(new Error(provider ? source.message : 'AI generation failed'), { statusCode: provider ? source.statusCode : 500, code: provider ? source.code : 'AI_BUILD_FAILED', stage, requestId, diagnostics: safeDiagnostics }); };

export async function buildApp(opts: { dataFile?: string; jwtSecret?: string; workspaceRoot?: string; encryptionKey?: string; fetch?: typeof fetch; aiTimeoutMs?: number; mcpLocalTestMode?: boolean; previewVerifier?: (projectId: string, previewUrl: string) => Promise<boolean> } = {}): Promise<FastifyInstance> {
  const secret = opts.jwtSecret ?? process.env.JWT_SECRET ?? 'development-only-change-me';
  const store = await new Store(opts.dataFile ?? process.env.DATA_FILE ?? './data/appweave.json', process.env.DATABASE_URL).load();
  const projectDatabases = process.env.DATABASE_URL ? new ProjectDatabaseManager(process.env.DATABASE_URL) : undefined;
  const encryptionKey = opts.encryptionKey ?? process.env.AI_ENCRYPTION_KEY ?? (process.env.NODE_ENV === 'test' ? 'test-only-development-encryption-key' : undefined);
  if (!encryptionKey) throw new Error('AI_ENCRYPTION_KEY is required');
  const providerFor = (config: AIProviderConfig) => { if (!config.keyCiphertext) throw bad('Provider credentials are unavailable; reconfigure this provider', 422, 'PROVIDER_KEY_UNAVAILABLE'); return new HttpAIProvider(config.provider, config, decryptProviderKey(config.keyCiphertext, encryptionKey), opts.fetch, opts.aiTimeoutMs ?? resolveAIProviderTimeoutMs(process.env.AI_PROVIDER_TIMEOUT_MS, DEFAULT_AI_PROVIDER_TIMEOUT_MS)); };
  const workspaceRoot = workspaceRootPath(opts.workspaceRoot ?? process.env.PROJECT_WORKSPACE_ROOT ?? './data/projects');
  const repos = new Map<string, ProjectVersionRepo>();
  const repoFor = (id: string) => { let repo = repos.get(id); if (!repo) { repo = new ProjectVersionRepo(workspaceRoot, id); repos.set(id, repo); } return repo; };
  const versionFiles = (specs: unknown[]): VersionFiles => ({ 'appweave/specification.json': JSON.stringify({ specs }, null, 2) });
  const app = Fastify({ logger: false, genReqId: () => store.id() });
  await app.register(cookie);
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(x => x.trim()).filter(Boolean) ?? [];
  await app.register(cors, { origin: allowedOrigins.length ? allowedOrigins : true, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as any).statusCode ?? (error instanceof ZodError ? 400 : 500);
    const code = (error as any).code ?? (error instanceof ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR');
    if (status >= 500) request.log.error({ code, requestId: request.id, stage: (error as any).stage, provider: (error as any).provider, model: (error as any).model, message: redact(String(error.message ?? '')) }, 'request failed');
    if ((error as any).retryAfter) reply.header('Retry-After', String((error as any).retryAfter));
    const safeMessage = status >= 500 && !String(code).startsWith('PROVIDER_') && code !== 'INVALID_APPLICATION_SPEC' && code !== 'AI_BUILD_FAILED' ? 'Internal server error' : error.message; const details = code === 'INVALID_APPLICATION_SPEC' ? { diagnostics: (error as any).diagnostics ?? [], stages: (error as any).stages ?? [], attempts: (error as any).attempts ?? 0 } : code === 'AI_BUILD_FAILED' || String(code).startsWith('PROVIDER_') ? { stage: (error as any).stage ?? 'provider_request', diagnostics: (error as any).diagnostics ?? [], requestId: request.id, retryAfter: (error as any).retryAfter, nextRetryAt: (error as any).nextRetryAt, attemptedProvider: (error as any).provider, attemptedModel: (error as any).model } : {}; reply.status(status).send({ error: { code, message: safeMessage, requestId: request.id, ...details } });
  });
  app.addHook('onRequest', async request => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(origin).host === request.headers.host; } catch { /* malformed origins are rejected below */ }
      if (!sameOrigin && !allowedOrigins.includes(origin)) throw bad('Origin is not allowed', 403, 'FORBIDDEN');
    }
  });
  store.installLifecycleHandlers();
  app.addHook('onClose', async () => { store.removeLifecycleHandlers(); await projectDatabases?.close(); await store.flush(); });
  app.addHook('onResponse', async (request) => { await store.commit(db => db.audits.push({ id: store.id(), userId: undefined, action: `${request.method} ${request.routeOptions.url}`, requestId: request.id, metadata: { status: request.routeOptions.url }, createdAt: now() })); });
  const cookieName = process.env.SESSION_COOKIE_NAME ?? 'appweave_session';
  const auth = (request: any) => userId(request, secret, cookieName, store);
  const mcpUser = (request: any) => auth(request);
  const project = (request: any) => ownedProject(store, request.params.projectId, auth(request));
  const audit = async (action: string, projectId: string | undefined, uid: string | undefined, requestId: string, metadata: unknown = {}) => store.commit(db => db.audits.push({ id: store.id(), action, projectId, userId: uid, requestId, metadata, createdAt: now() }));
  const projectPrivateKeys = ['providerConfigs', 'specs', 'builds', 'deployments', 'snapshots', 'projectMemory', 'decisions', 'buildHistory', 'graphNodes', 'graphEdges', 'aiBuildDrafts', 'products', 'surveyResponses'] as const;
  type ProjectPrivateKey = typeof projectPrivateKeys[number];
  type ProjectState = Partial<Record<ProjectPrivateKey, any[]>>;
  const projectState = async (p: Project): Promise<ProjectState> => {
    if (p.database && projectDatabases) {
      const stored = await projectDatabases.read(p.database);
      return Object.fromEntries(projectPrivateKeys.map(key => [key, Array.isArray(stored[key]) ? stored[key] : []])) as ProjectState;
    }
    return Object.fromEntries(projectPrivateKeys.map(key => [key, (store.data as any)[key].filter((x: any) => x.projectId === p.id)])) as ProjectState;
  };
  const saveProjectState = async (p: Project, state: ProjectState) => {
    if (p.database && projectDatabases) {
      const current = await projectDatabases.read(p.database);
      await projectDatabases.write(p.database, { ...current, ...state });
      return;
    }
    await store.commit(db => { for (const key of projectPrivateKeys) if (state[key]) (db as any)[key] = (db as any)[key].filter((x: any) => x.projectId !== p.id).concat(state[key]); });
  };
  const projectData = async (p: Project) => { const state = await projectState(p); return { products: (state.products ?? []) as Product[], surveyResponses: (state.surveyResponses ?? []) as SurveyResponse[] }; };
  const saveProjectData = async (p: Project, data: { products: Product[]; surveyResponses: SurveyResponse[] }) => { const state = await projectState(p); state.products = data.products; state.surveyResponses = data.surveyResponses; await saveProjectState(p, state); };
  const cookieSecure = process.env.SESSION_COOKIE_SECURE === 'true';
  const cookieMaxAge = Number(process.env.SESSION_COOKIE_MAX_AGE ?? 604800);
  const setSession = (reply: any, uid: string) => reply.setCookie(cookieName, token(uid, secret), { httpOnly: true, sameSite: 'lax', secure: cookieSecure, path: '/', maxAge: Number.isFinite(cookieMaxAge) && cookieMaxAge > 0 ? cookieMaxAge : 604800 });


  app.get('/health', async () => { const configs = (await Promise.all(store.data.projects.map(projectState))).flatMap(state => state.providerConfigs ?? []); return { status: 'ok', service: 'appweave-backend', version: appVersion, time: now(), storage: process.env.DATABASE_URL ? 'postgresql' : 'file-backed-local', pool: store.poolStatus(), providers: [...new Map(configs.map((c: any) => [c.provider, { provider: c.provider, baseUrl: c.baseUrl, model: c.model, configured: Boolean(c.keyConfigured && c.keyCiphertext) }])).values()] }; });
  app.get('/api/v1/auth/me', async request => { const uid = auth(request); const u = store.data.users.find(x => x.id === uid); if (!u) throw bad('User not found', 404, 'NOT_FOUND'); return { user: { id: u.id, email: u.email } }; });
  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = z.object({ email: z.string().email().transform(x => x.toLowerCase()), password: z.string().min(8).max(200) }).parse(request.body);
    if (store.data.users.some(u => u.email === body.email)) throw bad('Email already registered', 409, 'CONFLICT');
    const u = { id: store.id(), email: body.email, passwordHash: await hash(body.password), createdAt: now() };
    await store.commit(db => db.users.push(u));
    return setSession(reply.code(201), u.id).send({ user: { id: u.id, email: u.email }, token: token(u.id, secret) });
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = z.object({ email: z.string().email().transform(x => x.toLowerCase()), password: z.string() }).parse(request.body);
    const u = store.data.users.find(x => x.email === body.email);
    if (!u || !(await verify(body.password, u.passwordHash))) throw bad('Invalid credentials', 401, 'UNAUTHENTICATED');
    return setSession(reply, u.id).send({ user: { id: u.id, email: u.email }, token: token(u.id, secret) });
  });
  app.post('/api/v1/auth/logout', async (_request, reply) => reply.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: cookieSecure, path: '/' }).send({ ok: true }));
  const tokenView = (item: any) => ({ id: item.id, prefix: item.prefix, last4: item.last4, createdAt: item.createdAt, revokedAt: item.revokedAt ?? null });
  const listTokens = async (request: any) => { const uid = auth(request); return { tokens: store.data.personalAccessTokens.filter(item => item.userId === uid).map(tokenView) }; };
  const createToken = async (request: any, reply: any) => {
    const uid = auth(request); z.object({ name: z.string().trim().min(1).max(100).optional() }).strict().parse(request.body ?? {});
    const raw = `aw_pat_${randomBytes(32).toString('base64url')}`; const createdAt = now();
    const record = { id: store.id(), userId: uid, tokenHash: createHash('sha256').update(raw).digest('hex'), prefix: raw.slice(0, 16), last4: raw.slice(-4), createdAt };
    await store.commit(db => db.personalAccessTokens.push(record)); await audit('auth.personal_access_token.created', undefined, uid, request.id, { tokenId: record.id, prefix: record.prefix });
    return reply.code(201).send({ token: raw, ...tokenView(record) });
  };
  const revokeToken = async (request: any) => {
    const uid = auth(request); const params = z.object({ tokenId: z.string().uuid() }).parse(request.params);
    const record = store.data.personalAccessTokens.find(item => item.id === params.tokenId && item.userId === uid);
    if (!record) throw bad('Token not found', 404, 'NOT_FOUND');
    if (!record.revokedAt) { record.revokedAt = now(); await store.commit(db => db.personalAccessTokens); await audit('auth.personal_access_token.revoked', undefined, uid, request.id, { tokenId: record.id, prefix: record.prefix }); }
    return { token: tokenView(record) };
  };
  app.get('/api/v1/auth/tokens', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, listTokens);
  app.post('/api/v1/auth/tokens', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, createToken);
  app.delete('/api/v1/auth/tokens/:tokenId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, revokeToken);
  app.get('/api/v1/me/tokens', listTokens);
  app.post('/api/v1/me/tokens', createToken);
  app.delete('/api/v1/me/tokens/:tokenId', revokeToken);
  app.get('/api/v1/mcp/tokens', async request => { const uid = auth(request); return { tokens: store.data.mcpTokens.filter(x => x.userId === uid).map(mcpTokenView) }; });
  app.post('/api/v1/mcp/tokens', async (request, reply) => { const uid = auth(request); const body = z.object({ name: z.string().trim().min(1).max(80).default('MCP client') }).parse(request.body ?? {}); const raw = `aw_mcp_${randomBytes(32).toString('base64url')}`; const created = { id: store.id(), userId: uid, name: body.name, tokenHash: createHash('sha256').update(raw).digest('hex'), tokenPrefix: raw.slice(0, 16), createdAt: now() }; await store.commit(db => db.mcpTokens.push(created)); await audit('mcp.token.created', undefined, uid, request.id, { tokenId: created.id }); return reply.code(201).send({ token: raw, metadata: mcpTokenView(created) }); });
  app.post('/api/v1/mcp/tokens/:tokenId/revoke', async request => { const uid = auth(request); const item = store.data.mcpTokens.find(x => x.id === (request.params as any).tokenId && x.userId === uid); if (!item) throw bad('MCP token not found', 404, 'NOT_FOUND'); if (!item.revokedAt) { item.revokedAt = now(); await store.commit(db => db.mcpTokens); await audit('mcp.token.revoked', undefined, uid, request.id, { tokenId: item.id }); } return mcpTokenView(item); });
  app.post('/api/v1/mcp/connection-test', async request => { const uid = auth(request); const result = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: request.headers.authorization ?? '', cookie: request.headers.cookie ?? '' }, payload: { jsonrpc: '2.0', id: 'connection-test', method: 'tools/call', params: { name: 'appweave_health', arguments: {} } } }); const body = result.json(); if (result.statusCode >= 400 || body.error) return { connected: false, message: body.error?.message ?? 'MCP connection failed.' }; await audit('mcp.connection.tested', undefined, uid, request.id); return { connected: true, message: 'MCP endpoint responded to appweave_health.' }; });
  app.get('/api/v1/me/preferences', async request => {
    const uid = auth(request); return { preferences: store.data.userPreferences.find(x => x.userId === uid) ?? { userId: uid, selectedProjectId: null, selectedProvider: null, selectedModel: null } };
  });
  app.patch('/api/v1/me/preferences', async request => {
    const uid = auth(request); const changes = preferencesInput.parse(request.body);
    if (changes.selectedProjectId !== undefined && changes.selectedProjectId !== null) ownedProject(store, changes.selectedProjectId, uid);
    const current = store.data.userPreferences.find(x => x.userId === uid) ?? { userId: uid, updatedAt: now() };
    const updated: UserPreferences = { ...current, ...changes, updatedAt: now() };
    await store.commit(db => { const i = db.userPreferences.findIndex(x => x.userId === uid); if (i < 0) db.userPreferences.push(updated); else db.userPreferences[i] = updated; });
    return { preferences: updated };
  });
  app.get('/api/v1/projects', async request => { const uid = auth(request); return { projects: ownedProjects(store, uid).map(p => ({ ...p, previewUrl: previewUrl(p.id) })) }; });
  app.get('/api/v1/overview', async request => { const uid = auth(request); const projects = ownedProjects(store, uid); const states = await Promise.all(projects.map(projectState)); return { activeProjects: projects.length, requests: store.data.audits.filter(a => a.userId === uid || (process.env.NODE_ENV === 'development' && process.env.APPWEAVE_MCP_LOCAL_TEST_MODE === 'true' && a.userId === 'local-mcp-test-user')).length, deployments: states.reduce((count, state) => count + (state.deployments?.length ?? 0), 0), members: 1, errors: 0, databaseRecords: states.reduce((count, state) => count + (state.products?.length ?? 0), 0) }; });
  app.post('/api/v1/projects', async (request, reply) => {
    const uid = auth(request); const body = z.object({ name: z.string().trim().min(1).max(200) }).parse(request.body); const date = now();
      const projectId = store.id(); await ensureProjectStorage(workspaceRoot, projectId); const database = projectDatabases ? await projectDatabases.provision(projectId) : undefined; const p: Project = { id: projectId, ownerId: uid, name: body.name, environment: 'development', publicClientId: `aw_public_${projectId.replaceAll('-', '')}`, previewUrl: previewUrl(projectId), productionUrl: `${publicBaseUrl()}/app/${projectId}`, createdAt: date, updatedAt: date, ...(database ? { database } : {}) }; const settings: ProjectSettings = { projectId, name: p.name, allowedOrigins: [], usageLimit: 10000, lifecycleStatus: 'active', environment: p.environment, updatedAt: date }; await store.commit(db => { db.projects.push(p); db.projectSettings.push(settings); }); await audit('project.created', p.id, uid, request.id); return reply.code(201).send(p);
  });
  app.get('/api/v1/projects/:projectId', async request => { const p = project(request); return { ...p, previewUrl: previewUrl(p.id) }; });
   app.delete('/api/v1/projects/:projectId', async request => { const p = project(request); const uid = auth(request); await store.commit(db => { for (const value of Object.values(db) as unknown[]) if (Array.isArray(value)) { for (let i = value.length - 1; i >= 0; i--) if ((value[i] as any)?.projectId === p.id || (value[i] as any)?.id === p.id) value.splice(i, 1); } }); const { rm } = await import('node:fs/promises'); await rm(projectRoot(workspaceRoot, p.id), { recursive: true, force: true }); await audit('project.deleted', p.id, uid, request.id); return { deleted: p.id }; });
  app.get('/api/v1/projects/:projectId/settings', async request => {
    const p = project(request); const existing = store.data.projectSettings.find(x => x.projectId === p.id);
    return existing ?? { projectId: p.id, name: p.name, allowedOrigins: [], usageLimit: 10000, lifecycleStatus: 'active', environment: p.environment, updatedAt: p.updatedAt };
  });
  app.patch('/api/v1/projects/:projectId/settings', async request => {
    const p = project(request); const uid = auth(request); const changes = settingsInput.parse(request.body);
    const current = store.data.projectSettings.find(x => x.projectId === p.id) ?? { projectId: p.id, name: p.name, allowedOrigins: [], usageLimit: 10000, lifecycleStatus: 'active' as const, environment: p.environment, updatedAt: p.updatedAt };
    const updated: ProjectSettings = { ...current, ...changes, updatedAt: now() }; Object.assign(p, { name: updated.name, environment: updated.environment, updatedAt: updated.updatedAt });
    await store.commit(db => { const index = db.projectSettings.findIndex(x => x.projectId === p.id); if (index < 0) db.projectSettings.push(updated); else db.projectSettings[index] = updated; });
    await audit('project.settings.updated', p.id, uid, request.id, { fields: Object.keys(changes) }); return updated;
  });
  app.get('/api/v1/projects/:projectId/providers', async request => { const p = project(request); const configs = await projectState(p); return { providers: (['gemini', 'openai', 'openrouter', 'groq', 'nvidia'] as AIProviderName[]).map(provider => { const found = (configs.providerConfigs ?? []).find((x: any) => x.provider === provider); return found ? providerView(found) : { provider, ...providerDefaults[provider], configured: false, key: null }; }) }; });
  app.patch('/api/v1/projects/:projectId/providers/:provider', async request => {
    const p = project(request); const uid = auth(request); const { provider } = providerParam.parse(request.params); const input = providerInput.parse(request.body); const updatedAt = now();
    const secretKey = input.key ?? input.apiKey!;
    const config: AIProviderConfig = { id: store.id(), projectId: p.id, provider, baseUrl: input.baseUrl, model: input.model, keyCiphertext: encryptProviderKey(secretKey, encryptionKey), keyDigest: createHash('sha256').update(secretKey).digest('hex'), keyLast4: secretKey.length >= 8 ? secretKey.slice(-4) : undefined, keyConfigured: true, updatedAt };
    const state = await projectState(p); const configs = state.providerConfigs ?? (state.providerConfigs = []); const index = configs.findIndex((x: any) => x.provider === provider); if (index < 0) configs.push(config); else configs[index] = { ...config, id: configs[index]?.id }; await saveProjectState(p, state);
    await audit('project.provider.updated', p.id, uid, request.id, { provider, configured: true }); return providerView(config);
  });
  app.post('/api/v1/projects/:projectId/providers/:provider/test', async request => {
    const p = project(request); const { provider } = providerParam.parse(request.params); const config = (await projectState(p)).providerConfigs?.find((x: any) => x.provider === provider);
    if (!config?.keyConfigured || !config.keyCiphertext) return { provider, configured: false, reachable: false, message: 'Provider is not configured.' };
    const result = await providerFor(config).test(); return { provider, configured: true, reachable: result.reachable, message: result.message };
  });
  app.get('/api/v1/projects/:projectId/providers/openrouter/models', async request => {
    const p = project(request);
    const config = (await projectState(p)).providerConfigs?.find((x: any) => x.provider === 'openrouter');
    if (!config?.keyConfigured || !config.keyCiphertext) throw bad('OpenRouter is not configured for this project', 422, 'PROVIDER_NOT_CONFIGURED');
    return { models: await providerFor(config).discoverOpenRouterModels() };
  });
  app.delete('/api/v1/projects/:projectId/providers/:provider', async request => { const p = project(request); const uid = auth(request); const { provider } = providerParam.parse(request.params); const state = await projectState(p); const index = (state.providerConfigs ?? []).findIndex((x: any) => x.provider === provider); if (index >= 0) { state.providerConfigs!.splice(index, 1); await saveProjectState(p, state); } await audit('project.provider.removed', p.id, uid, request.id, { provider }); return { provider, configured: false }; });
  app.get('/api/v1/projects/:projectId/products', async request => { const p = project(request); return { products: (await projectData(p)).products }; });
  app.post('/api/database-test', async (request, reply) => { const uid = auth(request); const input = databaseTestInput.parse(request.body); const p = ownedProject(store, input.projectId, uid); if (!p.database || !projectDatabases) throw bad('This project has no provisioned PostgreSQL database', 503, 'DATABASE_NOT_PROVISIONED'); const record = await projectDatabases.insertDatabaseTest(p.database, { id: store.id(), fullName: input.fullName, email: input.email, phone: input.phone, city: input.city, testMessage: input.testMessage }); await audit('database_test.inserted', p.id, uid, request.id, { recordId: record.id }); return reply.code(201).send({ record }); });
  app.get('/api/database-test/:projectId', async request => { const p = project(request); if (!p.database || !projectDatabases) throw bad('This project has no provisioned PostgreSQL database', 503, 'DATABASE_NOT_PROVISIONED'); return { records: await projectDatabases.listDatabaseTests(p.database) }; });
  app.post('/api/v1/projects/:projectId/products', async (request, reply) => { const p = project(request); const uid = auth(request); const body = productInput.parse(request.body); const date = now(); const item: Product = { id: store.id(), projectId: p.id, ...body, createdAt: date, updatedAt: date }; const data = await projectData(p); data.products.push(item); await saveProjectData(p, data); await audit('product.created', p.id, uid, request.id); return reply.code(201).send(item); });
  app.post('/api/v1/projects/:projectId/survey-responses', async (request, reply) => {
    const p = project(request); const uid = auth(request);
    let serialized: string;
    try { serialized = JSON.stringify(request.body ?? {}); } catch { throw bad('Survey response payload is invalid', 400, 'VALIDATION_ERROR'); }
    if (Buffer.byteLength(serialized, 'utf8') > surveyResponseMaxBytes) throw bad('Survey response payload is too large', 413, 'PAYLOAD_TOO_LARGE');
    const body = surveyResponseInput.parse(request.body);
    const response: SurveyResponse = { id: store.id(), projectId: p.id, submittedBy: uid, ...(body.surveyId ? { surveyId: body.surveyId } : {}), answers: body.answers, consent: true, createdAt: now() };
     const data = await projectData(p); data.surveyResponses.push(response); await saveProjectData(p, data);
    await audit('survey.response.created', p.id, uid, request.id, { surveyId: response.surveyId, answerCount: Object.keys(response.answers).length, consent: true });
    return reply.code(201).send({ id: response.id, projectId: response.projectId, surveyId: response.surveyId ?? null, answers: response.answers, consent: response.consent, createdAt: response.createdAt });
  });
  app.post('/api/survey-responses', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    let serialized: string;
    try { serialized = JSON.stringify(request.body ?? {}); } catch { throw bad('Survey response payload is invalid', 400, 'VALIDATION_ERROR'); }
    if (Buffer.byteLength(serialized, 'utf8') > surveyResponseMaxBytes) throw bad('Survey response payload is too large', 413, 'PAYLOAD_TOO_LARGE');
    const body = publicSurveyResponseInput.parse(request.body);
    const p = body.projectId ? store.data.projects.find(item => item.id === body.projectId) : store.data.projects.find(item => item.publicClientId === body.publicClientId);
    if (!p || (body.publicClientId && p.publicClientId !== body.publicClientId)) throw bad('Survey project is not available', 404, 'NOT_FOUND');
    const response: SurveyResponse = { id: store.id(), projectId: p.id, submittedBy: 'anonymous', ...(body.surveyId ? { surveyId: body.surveyId } : {}), answers: body.answers, consent: true, createdAt: now() };
     const data = await projectData(p); data.surveyResponses.push(response); await saveProjectData(p, data);
    await audit('survey.response.created', p.id, undefined, request.id, { surveyId: response.surveyId, answerCount: Object.keys(response.answers).length, consent: true, public: true });
    return reply.code(201).send({ id: response.id, projectId: response.projectId, surveyId: response.surveyId ?? null, consent: response.consent, createdAt: response.createdAt });
  });
  app.get('/api/v1/projects/:projectId/survey-responses', async request => { const p = project(request); return { responses: (await projectData(p)).surveyResponses.map(({ submittedBy: _submittedBy, ...response }) => response) }; });
   app.get('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const data = await projectData(p); const item = data.products.find(x => x.id === (request.params as any).productId); if (!item) throw bad('Product not found', 404, 'NOT_FOUND'); return item; });
   app.patch('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const uid = auth(request); const data = await projectData(p); const item = data.products.find(x => x.id === (request.params as any).productId); if (!item) throw bad('Product not found', 404, 'NOT_FOUND'); const body = productInput.partial().parse(request.body); Object.assign(item, body, { updatedAt: now() }); await saveProjectData(p, data); await audit('product.updated', p.id, uid, request.id); return item; });
   app.delete('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const uid = auth(request); const data = await projectData(p); const i = data.products.findIndex(x => x.id === (request.params as any).productId); if (i < 0) throw bad('Product not found', 404, 'NOT_FOUND'); const [deleted] = data.products.splice(i, 1); await saveProjectData(p, data); await audit('product.deleted', p.id, uid, request.id); return { deleted: deleted.id }; });
  app.post('/api/v1/projects/:projectId/specifications/versions', async request => { const p = project(request); const uid = auth(request); const body = specInput.parse(request.body); const state = await projectState(p); const prior = state.specs ?? []; const spec = { id: store.id(), projectId: p.id, version: prior.length + 1, schema: body.schema as any, createdAt: now(), createdBy: uid }; prior.push(spec); state.specs = prior; await saveProjectState(p, state); return spec; });
  app.get('/api/v1/projects/:projectId/specifications/versions', async request => { const p = project(request); return { versions: await projectState(p).then(state => state.specs ?? []) }; });
  const buildProject = async (p: Project, uid: string, environment: 'preview'|'production', version: number, requestId: string, returnDetails = false) => {
     const state = await projectState(p); const spec = (state.specs ?? []).find((x: any) => x.version === version);
    if (!spec) throw bad('Specification version not found', 404, 'NOT_FOUND');
    const buildId = store.id(); const baseUrl = publicBaseUrl();
    const url = `${baseUrl}/${environment === 'preview' ? 'preview' : 'app'}/${p.id}`;
    const createdAt = now();
     const record: ProjectBuild = { id: buildId, projectId: p.id, environment, version, status: 'queued', runtime: 'unavailable', logs: ['build queued'], artifacts: [], createdAt, updatedAt: createdAt, createdBy: uid };
     (state.builds ??= []).push(record); await saveProjectState(p, state);
     record.status = 'building'; record.updatedAt = now(); await saveProjectState(p, state);
     let result: Awaited<ReturnType<typeof buildProjectArtifacts>>;
     try { await requireProjectStorage(workspaceRoot, p.id); result = await buildProjectArtifacts(p, workspaceRoot, environment, version, buildId, spec.schema); }
     catch (error) { const message = error instanceof Error ? error.message : 'Project storage is unavailable'; result = { status: 'failed', runtime: 'unavailable', logs: [`build failed: ${message}`], artifacts: [], error: message }; }
    Object.assign(record, { ...result, updatedAt: now() });
    if (result.status === 'failed') {
      const failedDeployment: Deployment = { id: store.id(), projectId: p.id, environment, version, status: 'failed', url, buildId, buildLog: result.logs, createdAt, createdBy: uid };
      (state.builds ??= [])[state.builds.findIndex((x: any) => x.id === buildId)] = record; (state.deployments ??= []).push(failedDeployment); await saveProjectState(p, state);
      if (returnDetails) return { deployment: failedDeployment, build: record };
      throw bad(`Build failed: ${result.error}`, 422, 'BUILD_FAILED');
    }
    const d: Deployment = { id: store.id(), projectId: p.id, environment, version, status: 'active', url, buildId, buildLog: result.logs, createdAt, createdBy: uid };
     (state.builds ??= [])[state.builds.findIndex((x: any) => x.id === buildId)] = record; (state.deployments ??= []).filter((x: any) => x.environment === environment && x.status === 'active').forEach((x: any) => x.status = 'rolled_back'); (state.deployments ??= []).push(d); (state.buildHistory ??= []).push({ id: store.id(), projectId: p.id, specVersion: version, stages: [{ name: 'validate_specification', status: 'completed' }, { name: 'artifact_build', status: 'completed', detail: result.runtime }], createdAt: now(), createdBy: uid }); await saveProjectState(p, state);
    await audit(`deployment.${environment}`, p.id, uid, requestId, { version, buildId }); return returnDetails ? { deployment: d, build: record } : d;
  };
  app.post('/api/v1/projects/:projectId/deployments', async request => { const p = project(request); const uid = auth(request); const b = z.object({ environment: z.enum(['preview','production']), version: z.number().int().positive() }).parse(request.body); return buildProject(p, uid, b.environment, b.version, request.id); });
  app.post('/api/v1/projects/:projectId/builds', async request => { const p = project(request); const uid = auth(request); const b = z.object({ environment: z.enum(['preview','production']).default('preview'), version: z.number().int().positive() }).parse(request.body ?? {}); return buildProject(p, uid, b.environment, b.version, request.id); });
  app.post('/api/v1/projects/:projectId/publish', async request => { const p = project(request); const uid = auth(request); const b = z.object({ version: z.number().int().positive() }).parse(request.body); return buildProject(p, uid, 'production', b.version, request.id); });
  app.get('/api/v1/projects/:projectId/builds', async request => { const p = project(request); const state = await projectState(p); return { builds: state.builds ?? [], deployments: state.deployments ?? [] }; });
  app.get('/api/v1/projects/:projectId/builds/:buildId', async request => { const p = project(request); const state = await projectState(p); const build = (state.builds ?? []).find((item: any) => item.id === (request.params as any).buildId); if (!build) throw bad('Build not found', 404, 'NOT_FOUND'); return { build, deployment: (state.deployments ?? []).find((item: any) => item.buildId === build.id) ?? null }; });
  app.get('/api/v1/projects/:projectId/runtime/status', async request => { project(request); return sandboxStatus(); });
  const activeArtifact = async (p: Project, environment: 'preview'|'production') => [...((await projectState(p)).deployments ?? [])].reverse().find((d: any) => d.environment === environment && d.status === 'active');
  const spaRouting = async (p: Project, environment: 'preview'|'production') => {
    const active = await activeArtifact(p, environment);
    const specs = (await projectState(p)).specs ?? []; const spec = active ? specs.find((item: any) => item.version === active.version) : [...specs].reverse()[0];
    return spec?.schema?.frontend?.routing === 'spa';
  };
  const artifactResponse = async (p: Project, environment: 'preview'|'production', root: string, path: string) => {
    try { return await readArtifactResponse(root, path, `/${environment === 'preview' ? 'preview' : 'app'}/${p.id}/`, await spaRouting(p, environment)); }
    catch { throw bad('Application artifact unavailable', 404, 'NOT_FOUND'); }
  };
  const previewRoot = async (p: Project): Promise<string | undefined> => {
    const active = [...(await projectState(p)).deployments ?? []].reverse().find((d: any) => d.environment === 'preview' && d.status === 'active');
    if (active) return join(workspaceRoot, p.id, 'preview', `version-${active.version}`, 'dist');
    const root = join(workspaceRoot, p.id);
    // Unbuilt package projects must never fall back to source HTML or stale root dist.
    if (await stat(join(root, 'package.json')).then(() => true, () => false)) return undefined;
    for (const candidate of [join(root, 'dist'), root, join(root, 'public')]) {
      try { await validateArtifact(candidate); return candidate; } catch { /* try a genuine static entrypoint */ }
    }
  };
  app.get('/preview/:projectId', async (request, reply) => {
    const p = ownedProject(store, (request.params as any).projectId, auth(request));
    let root = await previewRoot(p);
    if (!root) {
      const latest = [...(await projectState(p)).specs ?? []].reverse()[0];
      if (latest) { await buildProject(p, auth(request), 'preview', latest.version, request.id); root = await previewRoot(p); }
    }
    if (!root) {
      const packageExists = await stat(join(workspaceRoot, p.id, 'package.json')).then(() => true, () => false);
      if (packageExists) throw bad('No successful isolated preview build', 404, 'NOT_FOUND');
      return reply.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(p.name)} · AppWeave</title><style>body{margin:0;background:#f8f5ee;color:#18324a;font:16px system-ui,sans-serif}main{max-width:720px;margin:10vh auto;padding:48px;background:#fffdf8;border:1px solid #e8dcc9;border-radius:24px;box-shadow:0 20px 60px #18324a18}small{color:#a87532;letter-spacing:.14em;text-transform:uppercase}h1{font:700 42px Georgia,serif;margin:18px 0 10px}p{line-height:1.6;color:#566579}</style></head><body><main><small>AppWeave preview</small><h1>${escapeHtml(p.name)}</h1><p>Your project is connected, but it has not written an <code>index.html</code> yet. Ask the connected AI builder to create the page, then refresh this preview.</p></main></body></html>`);
    }
    const response = await artifactResponse(p, 'preview', root, '');
    return reply.type(response.type).send(response.body);
  });
  app.get('/preview/:projectId/*', async (request, reply) => {
    const p = ownedProject(store, (request.params as any).projectId, auth(request));
    const path = String((request.params as any)['*'] ?? '');
    const root = await previewRoot(p);
    if (!root) throw bad('Preview asset unavailable', 404, 'NOT_FOUND');
    const response = await artifactResponse(p, 'preview', root, path);
    return reply.type(response.type).send(response.body);
  });
  app.get('/app/:projectId', async (request, reply) => {
    const p = ownedProject(store, (request.params as any).projectId, auth(request));
    const build = await activeArtifact(p, 'production');
    if (!build) throw bad('No active production build', 404, 'NOT_FOUND');
    const response = await artifactResponse(p, 'production', join(workspaceRoot, p.id, 'production', `version-${build.version}`, 'dist'), '');
    return reply.type(response.type).send(response.body);
  });
  app.get('/app/:projectId/*', async (request, reply) => {
    const p = ownedProject(store, (request.params as any).projectId, auth(request));
    const build = await activeArtifact(p, 'production');
    if (!build) throw bad('No active production build', 404, 'NOT_FOUND');
    const response = await artifactResponse(p, 'production', join(workspaceRoot, p.id, 'production', `version-${build.version}`, 'dist'), String((request.params as any)['*'] ?? ''));
    return reply.type(response.type).send(response.body);
  });
  app.get('/api/v1/projects/:projectId/deployments', async request => { const p = project(request); return { deployments: (await projectState(p)).deployments ?? [] }; });
  const createVersion = async (request: any, reason: string, restoredSpecs?: any[]) => { const p = project(request); const uid = auth(request); const projectStateData = await projectState(p); const prior = projectStateData.snapshots ?? []; const state = { specs: (restoredSpecs ?? projectStateData.specs ?? []).map((x: any) => ({ ...x })) }; const files = versionFiles(state.specs); const commitSha = await repoFor(p.id).commit(files, `version ${prior.length + 1}: ${reason}`); const snapshot: Snapshot = { id: store.id(), projectId: p.id, version: prior.length + 1, reason, state, files, commitSha, createdAt: now(), createdBy: uid }; prior.push(snapshot); projectStateData.snapshots = prior; await saveProjectState(p, projectStateData); return snapshot; };
  app.post('/api/v1/projects/:projectId/snapshots', async (request, reply) => { const b = z.object({ reason: z.string().min(1).max(200).default('manual') }).parse(request.body ?? {}); return reply.code(201).send(await createVersion(request, b.reason)); });
  app.post('/api/v1/projects/:projectId/versions', async (request, reply) => { const b = z.object({ reason: z.string().min(1).max(200).default('manual') }).parse(request.body ?? {}); return reply.code(201).send(await createVersion(request, b.reason)); });
  app.get('/api/v1/projects/:projectId/snapshots', async request => { const p = project(request); return { snapshots: (await projectState(p)).snapshots?.map(({ state, files, ...meta }: any) => meta) ?? [] }; });
  app.get('/api/v1/projects/:projectId/versions', async request => { const p = project(request); return { versions: (await projectState(p)).snapshots?.map(({ state, files, ...meta }: any) => meta) ?? [] }; });
  const compare = async (request: any) => { const p = project(request); const params = request.params as any; const all = (await projectState(p)).snapshots ?? []; const left = all.find(x => x.id === (params.snapshotId ?? params.version) || String(x.version) === String(params.version)); const right = all.find(x => x.id === (params.otherSnapshotId ?? params.otherVersion) || String(x.version) === String(params.otherVersion)); if (!left || !right) throw bad('Version not found', 404, 'NOT_FOUND'); return { from: left.version, to: right.version, changedFiles: await repoFor(params.projectId).changedFiles(left.files ?? versionFiles(left.state.specs), right.files ?? versionFiles(right.state.specs)) }; };
  app.get('/api/v1/projects/:projectId/snapshots/:snapshotId/compare/:otherSnapshotId', compare);
  app.get('/api/v1/projects/:projectId/versions/:version/compare/:otherVersion', compare);
  const rollback = async (request: any, reply: any) => { const p = project(request); const uid = auth(request); const params = request.params as any; const projectStateData = await projectState(p); const target = (projectStateData.snapshots ?? []).find((x: any) => x.id === (params.snapshotId ?? params.version) || String(x.version) === String(params.version)); if (!target) throw bad('Version not found', 404, 'NOT_FOUND'); const specs = target.state?.specs; if (!Array.isArray(specs)) throw bad('Snapshot validation failed', 422, 'VERSION_INVALID'); specs.forEach(x => z.unknown().parse(x.schema)); const created = await createVersion(request, `rollback to version ${target.version}`, specs); projectStateData.specs = specs as any; const latest = (projectStateData.snapshots ?? []).find((x: any) => x.id === created.id); if (latest) latest.state = { specs: specs as any }; await saveProjectState(p, projectStateData); await audit('snapshot.rollback', p.id, uid, request.id, { snapshotId: target.id, newVersion: created.version }); return reply.send({ rolledBackTo: target.id, version: created.version, snapshot: { ...created, state: { specs } } }); };
  app.post('/api/v1/projects/:projectId/snapshots/:snapshotId/rollback', rollback);
  app.post('/api/v1/projects/:projectId/versions/:version/rollback', rollback);
  app.get('/api/v1/projects/:projectId/audit-logs', async request => { const p = project(request); return { logs: store.data.audits.filter(x => x.projectId === p.id) }; });
  app.get('/api/v1/projects/:projectId/schema', async request => { const p = project(request); const versions = await projectState(p).then(state => state.specs ?? []); return { entities: [{ name: 'Product', fields: [{ name: 'name', type: 'string', required: true }, { name: 'sku', type: 'string', required: true }, { name: 'price', type: 'number', required: true }, { name: 'description', type: 'string', required: false }] }], version: versions.at(-1)?.version ?? 0, migrationStatus: 'ready' }; });
  app.get('/api/v1/projects/:projectId/memory', async request => { const p = project(request); const state = await projectState(p); return { memory: state.projectMemory ?? [], decisions: state.decisions ?? [], builds: state.buildHistory ?? [] }; });
  app.get('/api/v1/projects/:projectId/graph', async request => { const p = project(request); const state = await projectState(p); return { nodes: state.graphNodes ?? [], edges: state.graphEdges ?? [] }; });
  /* AI BUILDER DISABLED: preserve implementation for a future re-enable.
  app.post('/api/v1/projects/:projectId/ai/builds/drafts', async (request, reply) => {
    const p = project(request); const uid = auth(request); const input = draftInput.parse(request.body);
    const configured = store.data.providerConfigs.find(x => x.projectId === p.id && x.provider === input.provider);
    const draft: AIBuildDraft = { id: store.id(), projectId: p.id, createdBy: uid, prompt: { request: safePrompt(input.prompt), fields: sanitizeFields(input.fields) }, provider: input.provider, model: input.model ?? configured?.model ?? providerDefaults[input.provider].model, stage: 'draft', status: 'draft', requestId: request.id, diagnostics: [], attempts: 0, context: { memory: store.data.projectMemory.filter(x => x.projectId === p.id).slice(-10).map(x => safePrompt(x.content)), graph: store.data.graphNodes.filter(x => x.projectId === p.id).slice(-20).map(x => safePrompt(`${x.type}:${x.label}`)) }, createdAt: now(), updatedAt: now() };
    await store.commit(db => db.aiBuildDrafts.push(draft)); return reply.code(201).send(draft);
   });
   */
   /* AI BUILDER ROUTES DISABLED: preserved for a future re-enable.
   app.get('/api/v1/projects/:projectId/ai/builds/latest', async request => { const p = project(request); const drafts = store.data.aiBuildDrafts.filter(x => x.projectId === p.id); return { build: drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null }; });
  app.post('/api/v1/projects/:projectId/ai/builds/:buildId/cancel', async request => { const p = project(request); const uid = auth(request); const draft = store.data.aiBuildDrafts.find(x => x.projectId === p.id && x.id === (request.params as any).buildId); if (!draft) throw bad('AI build not found', 404, 'NOT_FOUND'); draft.status = 'cancelled'; draft.stage = 'cancelled'; draft.updatedAt = now(); await store.commit(db => db.aiBuildDrafts); await audit('ai.build.cancelled', p.id, uid, request.id, { buildId: draft.id }); return draft; });
  app.post('/api/v1/projects/:projectId/ai/builds/:buildId/resume', async (request, reply) => {
    const p = project(request); const uid = auth(request); const draft = store.data.aiBuildDrafts.find(x => x.projectId === p.id && x.id === (request.params as any).buildId); if (!draft) throw bad('AI build not found', 404, 'NOT_FOUND');
    const changes = z.object({ provider: providerParam.shape.provider.optional(), model: z.string().trim().min(1).max(200).optional() }).strict().parse(request.body ?? {}); draft.provider = changes.provider ?? draft.provider; if (changes.model) draft.model = changes.model; draft.updatedAt = now(); await store.commit(db => db.aiBuildDrafts);
    const response = await app.inject({ method: 'POST', url: '/api/v1/ai/generate', headers: { authorization: request.headers.authorization ?? '', cookie: request.headers.cookie ?? '' }, payload: { projectId: p.id, draftId: draft.id, provider: draft.provider, model: draft.model, prompt: draft.prompt.request } });
    if (response.statusCode >= 400) return reply.code(response.statusCode).send(response.json());
    await audit('ai.build.resumed', p.id, uid, request.id, { buildId: draft.id }); return reply.code(response.statusCode).send(response.json());
  });
  app.post('/api/v1/ai/generate', async request => {
    const uid = auth(request); const body = z.object({ projectId: z.string().uuid(), provider: providerParam.shape.provider.optional(), model: z.string().trim().min(1).max(200).optional(), draftId: z.string().uuid().optional(), prompt: z.string().trim().min(1).max(4000) }).parse(request.body); const p = ownedProject(store, body.projectId, uid); const existing = body.draftId ? store.data.aiBuildDrafts.find(x => x.id === body.draftId && x.projectId === p.id) : undefined; if (body.draftId && !existing) throw bad('AI build not found', 404, 'NOT_FOUND'); if (existing?.status === 'running') throw Object.assign(bad('AI build is already running', 409, 'AI_BUILD_IN_PROGRESS'), { provider: existing.attemptedProvider ?? existing.provider, model: existing.attemptedModel ?? existing.model }); if (existing?.nextRetryAt && Date.parse(existing.nextRetryAt) > Date.now()) throw Object.assign(bad('AI provider retry window has not elapsed', 429, 'PROVIDER_RETRY_LATER'), { retryAfter: Math.max(1, Math.ceil((Date.parse(existing.nextRetryAt) - Date.now()) / 1000)), nextRetryAt: existing.nextRetryAt, provider: existing.attemptedProvider ?? existing.provider, model: existing.attemptedModel ?? existing.model, diagnostics: existing.diagnostics }); const selectedProvider = body.provider ?? store.data.providerConfigs.find(x => x.projectId === p.id && x.keyConfigured)?.provider ?? 'openai'; const draft = existing ?? ({ id: store.id(), projectId: p.id, createdBy: uid, prompt: { request: safePrompt(body.prompt), fields: {} }, provider: selectedProvider, model: body.model ?? providerDefaults[selectedProvider].model, stage: 'draft', status: 'draft', requestId: request.id, diagnostics: [], attempts: 0, context: { memory: [], graph: [] }, createdAt: now(), updatedAt: now() } as AIBuildDraft); if (!existing) await store.commit(db => db.aiBuildDrafts.push(draft)); draft.provider = body.provider ?? draft.provider; if (body.model) draft.model = body.model; draft.status = 'running'; draft.stage = 'provider_request'; draft.requestId = request.id; draft.attemptedProvider = draft.provider; draft.attemptedModel = draft.model; delete draft.retryAfter; delete draft.nextRetryAt; draft.updatedAt = now(); await store.commit(db => db.aiBuildDrafts);
    const config = store.data.providerConfigs.find(x => x.projectId === p.id && x.keyConfigured && x.provider === draft.provider); if (!config) { draft.status = 'failed'; draft.stage = 'provider_config'; draft.diagnostics = [{ code: 'PROVIDER_NOT_CONFIGURED', message: 'No AI provider is configured for this project' }]; await store.commit(db => db.aiBuildDrafts); throw bad('No AI provider is configured for this project', 422, 'PROVIDER_NOT_CONFIGURED'); }
    const memory = store.data.projectMemory.filter(x => x.projectId === p.id).slice(-10).map(x => x.content).join('\n'); const graph = store.data.graphNodes.filter(x => x.projectId === p.id).slice(-20).map(x => `${x.type}:${x.label}`).join(', ');
    const basePrompt = `You are AppWeave's application architect. All new web applications require React + Vite. Set schema.frontend.framework to "react-vite" and schema.frontend.language to "jsx" unless TypeScript is explicitly requested (then "tsx"). index.html is only the Vite entry document; UI and behavior belong in React components. Preserve the existing backend, database and authentication integrations. Return ONLY valid JSON with schema.entities, schema.relationships, schema.roles, schema.permissions, schema.api, schema.frontend, schema.pages, and schema.features. Field types may be string, number, boolean, date, enum, or multi_select. Entity fields may be strings or objects with type, required, options, and description. Context: ${memory}\nGraph: ${graph}\nRequest: ${draft.prompt.request}`;
    const stages: Array<{ name: string; status: 'completed'|'failed'; detail?: string }> = [{ name: 'prompt_context', status: 'completed' }]; let output = ''; let parsed = normalizeApplicationSpec(null); let attempts = 0; let prompt = basePrompt;
    while (attempts < 3) { attempts++; try { output = (await providerFor({ ...config, model: draft.model }).generate(prompt)).output; } catch (error) { stages.push({ name: 'provider_request', status: 'failed', detail: 'Provider request failed' }); draft.status = 'failed'; draft.stage = 'provider_request'; draft.attempts = attempts; const retryAfter = (error as any)?.retryAfter ?? ((String((error as any)?.code) === 'PROVIDER_TIMEOUT' || String((error as any)?.code) === 'PROVIDER_RATE_LIMITED') ? DEFAULT_PROVIDER_RETRY_AFTER_SECONDS : undefined); const nextRetryAt = retryAfter ? new Date(Date.now() + retryAfter * 1000).toISOString() : undefined; draft.retryAfter = retryAfter; draft.nextRetryAt = nextRetryAt; draft.attemptedProvider = draft.provider; draft.attemptedModel = draft.model; draft.diagnostics = [{ code: String((error as any)?.code ?? 'generation_failed'), message: redact(String((error as any)?.message ?? 'Provider request failed')), provider: draft.provider, model: draft.model, retryAfter, nextRetryAt }]; draft.updatedAt = now(); await store.commit(db => db.aiBuildDrafts); throw Object.assign(aiFailure('provider_request', request.id, error), { retryAfter, nextRetryAt, provider: draft.provider, model: draft.model }); } parsed = output.trim() ? parseProviderSpec(output) : { schema: {} as any, diagnostics: [{ path: '$', message: 'Provider returned an empty response', code: 'empty_response' }] }; if (!parsed.diagnostics.length) break; if (attempts < 3) prompt = `${basePrompt}\nRepair the previous output. Diagnostics: ${JSON.stringify(parsed.diagnostics)}\nPrevious output: ${redact(output).slice(0, 12000)}`; }
    stages.push({ name: 'validate_specification', status: parsed.diagnostics.length ? 'failed' : 'completed', detail: parsed.diagnostics.length ? `${parsed.diagnostics.length} diagnostic(s)` : undefined });
    if (parsed.diagnostics.length) { draft.status = 'failed'; draft.stage = 'validate_specification'; draft.attempts = attempts; draft.diagnostics = parsed.diagnostics.map(x => ({ code: String(x.code ?? 'invalid_specification'), message: String(x.message ?? 'Invalid application specification'), path: x.path })); draft.updatedAt = now(); await store.commit(db => db.aiBuildDrafts); throw Object.assign(bad('AI provider returned an invalid application specification', 502, 'INVALID_APPLICATION_SPEC'), { diagnostics: parsed.diagnostics, stages, attempts }); }
    const previous = store.data.specs.filter(x => x.projectId === p.id); const spec = { id: store.id(), projectId: p.id, version: previous.length + 1, schema: parsed.schema, createdAt: now(), createdBy: uid }; const safeRequirement = safePrompt(body.prompt); const mem = [{ id: store.id(), projectId: p.id, kind: 'requirement' as const, content: safeRequirement, createdAt: now(), createdBy: uid }, { id: store.id(), projectId: p.id, kind: 'context' as const, content: `Generated specification version ${spec.version}`, createdAt: now(), createdBy: uid }]; const n1 = { id: store.id(), projectId: p.id, type: 'application', label: p.name, createdAt: now() }; const n2 = { id: store.id(), projectId: p.id, type: 'specification', label: `v${spec.version}`, createdAt: now() };
     let preview: { deployment: Deployment; build: ProjectBuild };
     try {
       await store.commit(db => { db.specs.push(spec); db.projectMemory.push(...mem); db.graphNodes.push(n1, n2); db.graphEdges.push({ id: store.id(), projectId: p.id, from: n1.id, to: n2.id, type: 'produces', createdAt: now() }); db.buildHistory.push({ id: store.id(), projectId: p.id, specVersion: spec.version, stages: [...stages, { name: 'persist_context', status: 'completed' }], createdAt: now(), createdBy: uid }); });
       preview = await buildProject(p, uid, 'preview', spec.version, request.id, true) as { deployment: Deployment; build: ProjectBuild };
       draft.status = 'ready'; draft.stage = 'ready'; draft.attempts = attempts; draft.applicationSpec = { schema: parsed.schema }; draft.output = redact(output, [decryptProviderKey(config.keyCiphertext!, encryptionKey)]); draft.specVersion = spec.version; draft.diagnostics = []; delete draft.retryAfter; delete draft.nextRetryAt; draft.updatedAt = now(); await store.commit(db => db.aiBuildDrafts);
     } catch (error) { stages.push({ name: 'persist_context', status: 'failed', detail: 'Generated result could not be saved or built' }); draft.status = 'failed'; draft.stage = 'persist_context'; draft.attempts = attempts; draft.diagnostics = [{ code: 'persistence_failed', message: 'The generated specification could not be saved.' }]; draft.updatedAt = now(); await store.commit(db => db.aiBuildDrafts); throw aiFailure('persist_context', request.id, error); }
     return { provider: config.provider, configured: true, output: redact(output, [decryptProviderKey(config.keyCiphertext!, encryptionKey)]), applicationSpec: { schema: parsed.schema }, diagnostics: [], attempts, stages, specVersion: spec.version, build: preview.build, previewUrl: preview.deployment.url, previewStatus: preview.build.status, previewError: preview.build.error };
  });
   });
   */
   registerOAuthRoutes(app, store, secret, cookieName);
  const requestedMcpLocalTestMode = opts.mcpLocalTestMode ?? process.env.APPWEAVE_MCP_LOCAL_TEST_MODE === 'true';
  const mcpLocalTestMode = requestedMcpLocalTestMode && (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test');
  const verifyPreview = opts.previewVerifier ?? (async (projectId: string) => {
    const active = [...((await projectState(store.data.projects.find(item => item.id === projectId)!)).deployments ?? [])].reverse().find((item: any) => item.environment === 'preview' && item.status === 'active');
    if (!active) return false;
    try { await validateArtifact(join(workspaceRoot, projectId, 'preview', `version-${active.version}`, 'dist')); return true; } catch { return false; }
  });
  registerMcpRoutes({ app, store, workspaceRoot, secret, cookieName, repoFor, audit, mcpUserId: mcpUser, createSpecVersion: async (projectId, createdBy) => {
    const target = store.data.projects.find(item => item.id === projectId); if (!target) return; const targetState = await projectState(target); if ((targetState.specs ?? []).length) return;
    const schema = normalizeApplicationSpec({ schema: { entities: {}, relationships: [], roles: ['admin'], permissions: {}, api: {}, frontend: { source: 'project-files' }, pages: [], features: ['existing project files'] } }).schema;
    const spec = { id: store.id(), projectId, version: 1, schema, createdAt: now(), createdBy };
    targetState.specs = [spec]; await saveProjectState(target, targetState);
    return spec;
  }, rebuildPreview: async projectId => {
    const p = store.data.projects.find(item => item.id === projectId);
     const target = store.data.projects.find(item => item.id === projectId); const newest = target ? [...((await projectState(target)).specs ?? [])].sort((a: any, b: any) => b.version - a.version)[0] : undefined;
     if (p && newest) {
       try { await buildProject(p, newest.createdBy, 'preview', newest.version, `mcp-${store.id()}`); }
       catch { /* failed builds are recorded while the active artifact remains untouched */ }
     }
   }, verifyPreview, allowUnauthenticated: mcpLocalTestMode, projectDatabases });
  return app;
}
if (process.env.NODE_ENV !== 'test') buildApp().then(app => app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })).catch(err => { console.error(err); process.exit(1); });

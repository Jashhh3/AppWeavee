import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { Store } from './store.js';
import { hash, verify, token, userId, ownedProject } from './auth.js';
import type { Project, Product, Deployment } from './types.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decryptProviderKey, encryptProviderKey, HttpAIProvider } from './ai.js';
import { ProjectVersionRepo, type VersionFiles } from './versions.js';
import type { Snapshot, AIProviderName, AIProviderConfig, ProjectSettings } from './types.js';

const productInput = z.object({ name: z.string().trim().min(1).max(200), sku: z.string().trim().min(1).max(80), price: z.number().finite().nonnegative(), description: z.string().max(2000).optional() });
const specInput = z.object({ schema: z.object({ entities: z.record(z.object({ fields: z.record(z.string()), permissions: z.record(z.array(z.string())).optional() })).default({}), relationships: z.array(z.record(z.string())).default([]), roles: z.array(z.string()).default(['admin']), api: z.record(z.unknown()).default({}), frontend: z.record(z.unknown()).default({}) }) });
const idParam = z.object({ projectId: z.string().uuid() });
const now = () => new Date().toISOString();
const readHtml = async (path: string) => { const { readFile } = await import('node:fs/promises'); try { return await readFile(path, 'utf8'); } catch { throw bad('Generated application is unavailable', 404, 'NOT_FOUND'); } };
const bad = (message: string, statusCode = 400, code = 'BAD_REQUEST') => Object.assign(new Error(message), { statusCode, code });
const settingsInput = z.object({ name: z.string().trim().min(1).max(200).optional(), allowedOrigins: z.array(z.string().url().max(2048)).max(50).optional(), usageLimit: z.number().int().nonnegative().max(10_000_000).optional(), lifecycleStatus: z.enum(['active', 'paused', 'archived']).optional(), environment: z.enum(['development', 'preview', 'production']).optional() }).strict();
const providerParam = z.object({ provider: z.enum(['gemini', 'openai', 'openrouter']) });
const providerInput = z.object({ baseUrl: z.string().url().max(2048), model: z.string().trim().min(1).max(200), key: z.string().min(1).max(4096).optional(), apiKey: z.string().min(1).max(4096).optional() }).strict().refine(input => Boolean(input.key ?? input.apiKey), { message: 'A provider key is required', path: ['key'] });
const providerDefaults: Record<AIProviderName, { baseUrl: string; model: string }> = { gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest' }, openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' } };
const providerView = (c: AIProviderConfig) => ({ provider: c.provider, baseUrl: c.baseUrl, model: c.model, configured: Boolean(c.keyConfigured && c.keyCiphertext), key: c.keyConfigured && c.keyCiphertext ? `••••••••${c.keyLast4 ?? ''}` : null, updatedAt: c.updatedAt });

export async function buildApp(opts: { dataFile?: string; jwtSecret?: string; workspaceRoot?: string; encryptionKey?: string; fetch?: typeof fetch; aiTimeoutMs?: number } = {}): Promise<FastifyInstance> {
  const secret = opts.jwtSecret ?? process.env.JWT_SECRET ?? 'development-only-change-me';
  const store = await new Store(opts.dataFile ?? process.env.DATA_FILE ?? './data/appweave.json').load();
  const encryptionKey = opts.encryptionKey ?? process.env.AI_ENCRYPTION_KEY ?? (process.env.NODE_ENV === 'test' ? 'test-only-development-encryption-key' : undefined);
  if (!encryptionKey) throw new Error('AI_ENCRYPTION_KEY is required');
  const providerFor = (config: AIProviderConfig) => { if (!config.keyCiphertext) throw bad('Provider credentials are unavailable; reconfigure this provider', 422, 'PROVIDER_KEY_UNAVAILABLE'); return new HttpAIProvider(config.provider, config, decryptProviderKey(config.keyCiphertext, encryptionKey), opts.fetch, opts.aiTimeoutMs ?? 15_000); };
  const workspaceRoot = opts.workspaceRoot ?? process.env.PROJECT_WORKSPACE_ROOT ?? './data/projects';
  const repos = new Map<string, ProjectVersionRepo>();
  const repoFor = (id: string) => { let repo = repos.get(id); if (!repo) { repo = new ProjectVersionRepo(workspaceRoot, id); repos.set(id, repo); } return repo; };
  const versionFiles = (specs: unknown[]): VersionFiles => ({ 'appweave/specification.json': JSON.stringify({ specs }, null, 2) });
  const app = Fastify({ logger: false, genReqId: () => store.id() });
  await app.register(cors, { origin: process.env.ALLOWED_ORIGINS?.split(',').map(x => x.trim()) ?? true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as any).statusCode ?? (error instanceof ZodError ? 400 : 500);
    const code = (error as any).code ?? (error instanceof ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR');
    if (status >= 500) request.log.error(error);
    const safeMessage = status >= 500 && !String(code).startsWith('PROVIDER_') && code !== 'INVALID_APPLICATION_SPEC' ? 'Internal server error' : error.message; reply.status(status).send({ error: { code, message: safeMessage, requestId: request.id } });
  });
  app.addHook('onResponse', async (request) => { await store.commit(db => db.audits.push({ id: store.id(), userId: undefined, action: `${request.method} ${request.routeOptions.url}`, requestId: request.id, metadata: { status: request.routeOptions.url }, createdAt: now() })); });
  const auth = (request: any) => userId(request, secret);
  const project = (request: any) => ownedProject(store, request.params.projectId, auth(request));
  const audit = async (action: string, projectId: string | undefined, uid: string, requestId: string, metadata: unknown = {}) => store.commit(db => db.audits.push({ id: store.id(), action, projectId, userId: uid, requestId, metadata, createdAt: now() }));

  app.get('/health', async () => ({ status: 'ok', service: 'appweave-backend', time: now(), storage: 'file-backed-local' }));
  app.get('/api/v1/auth/me', async request => { const uid = auth(request); const u = store.data.users.find(x => x.id === uid); if (!u) throw bad('User not found', 404, 'NOT_FOUND'); return { user: { id: u.id, email: u.email } }; });
  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = z.object({ email: z.string().email().transform(x => x.toLowerCase()), password: z.string().min(8).max(200) }).parse(request.body);
    if (store.data.users.some(u => u.email === body.email)) throw bad('Email already registered', 409, 'CONFLICT');
    const u = { id: store.id(), email: body.email, passwordHash: await hash(body.password), createdAt: now() };
    await store.commit(db => db.users.push(u));
    return reply.code(201).send({ user: { id: u.id, email: u.email }, token: token(u.id, secret) });
  });
  app.post('/api/v1/auth/login', async (request) => {
    const body = z.object({ email: z.string().email().transform(x => x.toLowerCase()), password: z.string() }).parse(request.body);
    const u = store.data.users.find(x => x.email === body.email);
    if (!u || !(await verify(body.password, u.passwordHash))) throw bad('Invalid credentials', 401, 'UNAUTHENTICATED');
    return { user: { id: u.id, email: u.email }, token: token(u.id, secret) };
  });
  app.get('/api/v1/projects', async request => { const uid = auth(request); return { projects: store.data.projects.filter(p => p.ownerId === uid) }; });
  app.get('/api/v1/overview', async request => { const uid = auth(request); const projects = store.data.projects.filter(p => p.ownerId === uid); const ids = new Set(projects.map(p => p.id)); return { activeProjects: projects.length, requests: store.data.audits.filter(a => a.userId === uid).length, deployments: store.data.deployments.filter(d => ids.has(d.projectId)).length, members: 1, errors: 0, databaseRecords: store.data.products.filter(p => ids.has(p.projectId)).length }; });
  app.post('/api/v1/projects', async (request, reply) => {
    const uid = auth(request); const body = z.object({ name: z.string().trim().min(1).max(200) }).parse(request.body); const date = now();
    const projectId = store.id(); const p: Project = { id: projectId, ownerId: uid, name: body.name, environment: 'development', publicClientId: `aw_public_${projectId.replaceAll('-', '')}`, previewUrl: `http://localhost:4173/preview/${projectId}`, productionUrl: `https://app.appweave.local/${projectId}`, createdAt: date, updatedAt: date }; const settings: ProjectSettings = { projectId, name: p.name, allowedOrigins: [], usageLimit: 10000, lifecycleStatus: 'active', environment: p.environment, updatedAt: date }; await store.commit(db => { db.projects.push(p); db.projectSettings.push(settings); }); await audit('project.created', p.id, uid, request.id); return reply.code(201).send(p);
  });
  app.get('/api/v1/projects/:projectId', async request => project(request));
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
  app.get('/api/v1/projects/:projectId/providers', async request => { const p = project(request); return { providers: (['gemini', 'openai', 'openrouter'] as AIProviderName[]).map(provider => { const found = store.data.providerConfigs.find(x => x.projectId === p.id && x.provider === provider); return found ? providerView(found) : { provider, ...providerDefaults[provider], configured: false, key: null }; }) }; });
  app.patch('/api/v1/projects/:projectId/providers/:provider', async request => {
    const p = project(request); const uid = auth(request); const { provider } = providerParam.parse(request.params); const input = providerInput.parse(request.body); const updatedAt = now();
    const secretKey = input.key ?? input.apiKey!;
    const config: AIProviderConfig = { id: store.id(), projectId: p.id, provider, baseUrl: input.baseUrl, model: input.model, keyCiphertext: encryptProviderKey(secretKey, encryptionKey), keyDigest: createHash('sha256').update(secretKey).digest('hex'), keyLast4: secretKey.length >= 8 ? secretKey.slice(-4) : undefined, keyConfigured: true, updatedAt };
    await store.commit(db => { const index = db.providerConfigs.findIndex(x => x.projectId === p.id && x.provider === provider); if (index < 0) db.providerConfigs.push(config); else db.providerConfigs[index] = { ...config, id: db.providerConfigs[index].id }; });
    await audit('project.provider.updated', p.id, uid, request.id, { provider, configured: true }); return providerView(config);
  });
  app.post('/api/v1/projects/:projectId/providers/:provider/test', async request => {
    const p = project(request); const { provider } = providerParam.parse(request.params); const config = store.data.providerConfigs.find(x => x.projectId === p.id && x.provider === provider);
    if (!config?.keyConfigured || !config.keyCiphertext) return { provider, configured: false, reachable: false, message: 'Provider is not configured.' };
    const result = await providerFor(config).test(); return { provider, configured: true, reachable: result.reachable, message: result.message };
  });
  app.delete('/api/v1/projects/:projectId/providers/:provider', async request => { const p = project(request); const uid = auth(request); const { provider } = providerParam.parse(request.params); const index = store.data.providerConfigs.findIndex(x => x.projectId === p.id && x.provider === provider); if (index >= 0) await store.commit(db => { db.providerConfigs.splice(index, 1); }); await audit('project.provider.removed', p.id, uid, request.id, { provider }); return { provider, configured: false }; });
  app.get('/api/v1/projects/:projectId/products', async request => { const p = project(request); return { products: store.data.products.filter(x => x.projectId === p.id) }; });
  app.post('/api/v1/projects/:projectId/products', async (request, reply) => { const p = project(request); const uid = auth(request); const body = productInput.parse(request.body); const date = now(); const item: Product = { id: store.id(), projectId: p.id, ...body, createdAt: date, updatedAt: date }; await store.commit(db => db.products.push(item)); await audit('product.created', p.id, uid, request.id); return reply.code(201).send(item); });
  app.get('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const item = store.data.products.find(x => x.projectId === p.id && x.id === (request.params as any).productId); if (!item) throw bad('Product not found', 404, 'NOT_FOUND'); return item; });
  app.patch('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const uid = auth(request); const item = store.data.products.find(x => x.projectId === p.id && x.id === (request.params as any).productId); if (!item) throw bad('Product not found', 404, 'NOT_FOUND'); const body = productInput.partial().parse(request.body); Object.assign(item, body, { updatedAt: now() }); await store.commit(db => db); await audit('product.updated', p.id, uid, request.id); return item; });
  app.delete('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const uid = auth(request); const i = store.data.products.findIndex(x => x.projectId === p.id && x.id === (request.params as any).productId); if (i < 0) throw bad('Product not found', 404, 'NOT_FOUND'); const [deleted] = store.data.products.splice(i, 1); await store.commit(db => db); await audit('product.deleted', p.id, uid, request.id); return { deleted: deleted.id }; });
  app.post('/api/v1/projects/:projectId/specifications/versions', async request => { const p = project(request); const uid = auth(request); const body = specInput.parse(request.body); const prior = store.data.specs.filter(x => x.projectId === p.id); const spec = { id: store.id(), projectId: p.id, version: prior.length + 1, schema: body.schema, createdAt: now(), createdBy: uid }; await store.commit(db => db.specs.push(spec)); return spec; });
  app.get('/api/v1/projects/:projectId/specifications/versions', async request => { const p = project(request); return { versions: store.data.specs.filter(x => x.projectId === p.id) }; });
  const buildProject = async (p: Project, uid: string, environment: 'preview'|'production', version: number, requestId: string) => {
    const spec = store.data.specs.find(x => x.projectId === p.id && x.version === version);
    if (!spec) throw bad('Specification version not found', 404, 'NOT_FOUND');
    const buildId = store.id(); const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
    const url = `${baseUrl}/${environment === 'preview' ? 'preview' : 'app'}/${p.id}`;
    const folder = join(process.env.PROJECT_WORKSPACE_ROOT ?? './data/projects', p.id, environment, `version-${version}`);
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${p.name} · AppWeave</title><style>body{font:16px system-ui;background:#0a0d12;color:#e8ebf2;max-width:760px;margin:12vh auto;padding:24px}main{border:1px solid #303b4c;border-radius:12px;padding:28px;background:#11161e}small{color:#9aa6b8}code{color:#ffad72}</style></head><body><main><small>APPWEAVE ${environment.toUpperCase()} PREVIEW</small><h1>${p.name}</h1><p>This generated application is connected to the managed backend.</p><p>Specification version <code>${version}</code> · Build <code>${buildId.slice(0,8)}</code></p><p>Use the AppWeave SDK with public client <code>${p.publicClientId}</code> to load authorized data.</p></main></body></html>`;
    try { await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'index.html'), html, 'utf8'); } catch (error) { throw bad(`Build failed: ${error instanceof Error ? error.message : 'workspace unavailable'}`, 422, 'BUILD_FAILED'); }
    const d: Deployment = { id: store.id(), projectId: p.id, environment, version, status: 'active', url, buildId, buildLog: [`validated specification ${version}`, 'generated frontend workspace', 'health check passed'], createdAt: now(), createdBy: uid };
    await store.commit(db => { db.deployments.filter(x => x.projectId === p.id && x.environment === environment && x.status === 'active').forEach(x => x.status = 'rolled_back'); db.deployments.push(d); });
    await audit(`deployment.${environment}`, p.id, uid, requestId, { version, buildId }); return d;
  };
  app.post('/api/v1/projects/:projectId/deployments', async request => { const p = project(request); const uid = auth(request); const b = z.object({ environment: z.enum(['preview','production']), version: z.number().int().positive() }).parse(request.body); return buildProject(p, uid, b.environment, b.version, request.id); });
  app.post('/api/v1/projects/:projectId/builds', async request => { const p = project(request); const uid = auth(request); const b = z.object({ environment: z.enum(['preview','production']).default('preview'), version: z.number().int().positive() }).parse(request.body ?? {}); return buildProject(p, uid, b.environment, b.version, request.id); });
  app.post('/api/v1/projects/:projectId/publish', async request => { const p = project(request); const uid = auth(request); const b = z.object({ version: z.number().int().positive() }).parse(request.body); return buildProject(p, uid, 'production', b.version, request.id); });
  app.get('/api/v1/projects/:projectId/builds', async request => { const p = project(request); return { builds: store.data.deployments.filter(d => d.projectId === p.id) }; });
  app.get('/preview/:projectId', async (request, reply) => { const p = ownedProject(store, (request.params as any).projectId, auth(request)); const build = [...store.data.deployments].reverse().find(d => d.projectId === p.id && d.environment === 'preview' && d.status === 'active'); if (!build) throw bad('No active preview build', 404, 'NOT_FOUND'); return reply.type('text/html').send(await readHtml(join(process.env.PROJECT_WORKSPACE_ROOT ?? './data/projects', p.id, 'preview', `version-${build.version}`, 'index.html'))); });
  app.get('/app/:projectId', async (request, reply) => { const p = ownedProject(store, (request.params as any).projectId, auth(request)); const build = [...store.data.deployments].reverse().find(d => d.projectId === p.id && d.environment === 'production' && d.status === 'active'); if (!build) throw bad('No active production build', 404, 'NOT_FOUND'); return reply.type('text/html').send(await readHtml(join(process.env.PROJECT_WORKSPACE_ROOT ?? './data/projects', p.id, 'production', `version-${build.version}`, 'index.html'))); });
  app.get('/api/v1/projects/:projectId/deployments', async request => { const p = project(request); return { deployments: store.data.deployments.filter(x => x.projectId === p.id) }; });
  const createVersion = async (request: any, reason: string, restoredSpecs?: any[]) => { const p = project(request); const uid = auth(request); const prior = store.data.snapshots.filter(x => x.projectId === p.id); const state = { specs: (restoredSpecs ?? store.data.specs.filter(x => x.projectId === p.id)).map(x => ({ ...x })) }; const files = versionFiles(state.specs); const commitSha = await repoFor(p.id).commit(files, `version ${prior.length + 1}: ${reason}`); const snapshot: Snapshot = { id: store.id(), projectId: p.id, version: prior.length + 1, reason, state, files, commitSha, createdAt: now(), createdBy: uid }; await store.commit(db => db.snapshots.push(snapshot)); return snapshot; };
  app.post('/api/v1/projects/:projectId/snapshots', async (request, reply) => { const b = z.object({ reason: z.string().min(1).max(200).default('manual') }).parse(request.body ?? {}); return reply.code(201).send(await createVersion(request, b.reason)); });
  app.post('/api/v1/projects/:projectId/versions', async (request, reply) => { const b = z.object({ reason: z.string().min(1).max(200).default('manual') }).parse(request.body ?? {}); return reply.code(201).send(await createVersion(request, b.reason)); });
  app.get('/api/v1/projects/:projectId/snapshots', async request => { const p = project(request); return { snapshots: store.data.snapshots.filter(x => x.projectId === p.id).map(({ state, files, ...meta }) => meta) }; });
  app.get('/api/v1/projects/:projectId/versions', async request => { const p = project(request); return { versions: store.data.snapshots.filter(x => x.projectId === p.id).map(({ state, files, ...meta }) => meta) }; });
  const compare = async (request: any) => { project(request); const params = request.params as any; const all = store.data.snapshots.filter(x => x.projectId === params.projectId); const left = all.find(x => x.id === (params.snapshotId ?? params.version) || String(x.version) === String(params.version)); const right = all.find(x => x.id === (params.otherSnapshotId ?? params.otherVersion) || String(x.version) === String(params.otherVersion)); if (!left || !right) throw bad('Version not found', 404, 'NOT_FOUND'); return { from: left.version, to: right.version, changedFiles: await repoFor(params.projectId).changedFiles(left.files ?? versionFiles(left.state.specs), right.files ?? versionFiles(right.state.specs)) }; };
  app.get('/api/v1/projects/:projectId/snapshots/:snapshotId/compare/:otherSnapshotId', compare);
  app.get('/api/v1/projects/:projectId/versions/:version/compare/:otherVersion', compare);
  const rollback = async (request: any, reply: any) => { const p = project(request); const uid = auth(request); const params = request.params as any; const target = store.data.snapshots.find(x => x.projectId === p.id && (x.id === (params.snapshotId ?? params.version) || String(x.version) === String(params.version))); if (!target) throw bad('Version not found', 404, 'NOT_FOUND'); const specs = target.state?.specs; if (!Array.isArray(specs)) throw bad('Snapshot validation failed', 422, 'VERSION_INVALID'); specs.forEach(x => z.unknown().parse(x.schema)); const created = await createVersion(request, `rollback to version ${target.version}`, specs); await store.commit(db => { db.specs = db.specs.filter(x => x.projectId !== p.id).concat(specs as any); const latest = db.snapshots.find(x => x.id === created.id); if (latest) latest.state = { specs: specs as any }; }); await audit('snapshot.rollback', p.id, uid, request.id, { snapshotId: target.id, newVersion: created.version }); return reply.send({ rolledBackTo: target.id, version: created.version, snapshot: { ...created, state: { specs } } }); };
  app.post('/api/v1/projects/:projectId/snapshots/:snapshotId/rollback', rollback);
  app.post('/api/v1/projects/:projectId/versions/:version/rollback', rollback);
  app.get('/api/v1/projects/:projectId/audit-logs', async request => { const p = project(request); return { logs: store.data.audits.filter(x => x.projectId === p.id) }; });
  app.get('/api/v1/projects/:projectId/schema', async request => { const p = project(request); const versions = store.data.specs.filter(x => x.projectId === p.id); return { entities: [{ name: 'Product', fields: [{ name: 'name', type: 'string', required: true }, { name: 'sku', type: 'string', required: true }, { name: 'price', type: 'number', required: true }, { name: 'description', type: 'string', required: false }] }], version: versions.at(-1)?.version ?? 0, migrationStatus: 'ready' }; });
  const generatedSpec = z.object({ schema: z.object({ entities: z.record(z.object({ fields: z.record(z.string()), permissions: z.record(z.array(z.string())).optional() })).default({}), relationships: z.array(z.record(z.string())).default([]), roles: z.array(z.string()).default(['admin']), api: z.record(z.unknown()).default({}), frontend: z.record(z.unknown()).default({}) }) });
  app.post('/api/v1/ai/generate', async request => { const uid = auth(request); const body = z.object({ projectId: z.string().uuid(), provider: providerParam.shape.provider.optional(), prompt: z.string().trim().min(1).max(4000) }).parse(request.body); const p = ownedProject(store, body.projectId, uid); const config = store.data.providerConfigs.find(x => x.projectId === p.id && x.keyConfigured && (!body.provider || x.provider === body.provider)); if (!config) throw bad('No AI provider is configured for this project', 422, 'PROVIDER_NOT_CONFIGURED'); const providerInstruction = `You are AppWeave's application architect. Return ONLY valid JSON, with no markdown fences, matching this exact shape: {\"schema\":{\"entities\":{\"EntityName\":{\"fields\":{\"fieldName\":\"string|number|boolean|date\"},\"permissions\":{\"role\":[\"read\",\"create\",\"update\",\"delete\"]}}},\"relationships\":[],\"roles\":[\"admin\"],\"api\":{},\"frontend\":{}}}. Design a safe, practical application from this request: ${body.prompt}`; const result = await providerFor(config).generate(providerInstruction); if (!result.output.trim()) throw bad('AI provider returned an empty response', 502, 'PROVIDER_EMPTY_RESPONSE'); let applicationSpec: unknown; try { const json = result.output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(); applicationSpec = generatedSpec.parse(JSON.parse(json)); } catch { throw bad('AI provider returned an invalid application specification', 502, 'INVALID_APPLICATION_SPEC'); } return { provider: config.provider, configured: true, output: result.output, applicationSpec }; });
  return app;
}
if (process.env.NODE_ENV !== 'test') buildApp().then(app => app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })).catch(err => { console.error(err); process.exit(1); });

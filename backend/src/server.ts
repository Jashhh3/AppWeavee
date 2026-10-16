import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { Store } from './store.js';
import { hash, verify, token, userId, ownedProject } from './auth.js';
import type { Project, Product } from './types.js';
import { SafeStubProvider } from './ai.js';

const productInput = z.object({ name: z.string().trim().min(1).max(200), sku: z.string().trim().min(1).max(80), price: z.number().finite().nonnegative(), description: z.string().max(2000).optional() });
const specInput = z.object({ schema: z.object({ entities: z.record(z.object({ fields: z.record(z.string()), permissions: z.record(z.array(z.string())).optional() })).default({}), relationships: z.array(z.record(z.string())).default([]), roles: z.array(z.string()).default(['admin']), api: z.record(z.unknown()).default({}), frontend: z.record(z.unknown()).default({}) }) });
const idParam = z.object({ projectId: z.string().uuid() });
const now = () => new Date().toISOString();
const bad = (message: string, statusCode = 400, code = 'BAD_REQUEST') => Object.assign(new Error(message), { statusCode, code });

export async function buildApp(opts: { dataFile?: string; jwtSecret?: string } = {}): Promise<FastifyInstance> {
  const secret = opts.jwtSecret ?? process.env.JWT_SECRET ?? 'development-only-change-me';
  const store = await new Store(opts.dataFile ?? process.env.DATA_FILE ?? './data/appweave.json').load();
  const ai = new SafeStubProvider();
  const app = Fastify({ logger: false, genReqId: () => store.id() });
  await app.register(cors, { origin: process.env.ALLOWED_ORIGINS?.split(',').map(x => x.trim()) ?? true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as any).statusCode ?? (error instanceof ZodError ? 400 : 500);
    const code = (error as any).code ?? (error instanceof ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR');
    if (status >= 500) request.log.error(error);
    reply.status(status).send({ error: { code, message: status >= 500 ? 'Internal server error' : error.message, requestId: request.id } });
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
    const projectId = store.id(); const p: Project = { id: projectId, ownerId: uid, name: body.name, environment: 'development', publicClientId: `aw_public_${projectId.replaceAll('-', '')}`, previewUrl: `http://localhost:4173/preview/${projectId}`, productionUrl: `https://app.appweave.local/${projectId}`, createdAt: date, updatedAt: date }; await store.commit(db => db.projects.push(p)); await audit('project.created', p.id, uid, request.id); return reply.code(201).send(p);
  });
  app.get('/api/v1/projects/:projectId', async request => project(request));
  app.get('/api/v1/projects/:projectId/products', async request => { const p = project(request); return { products: store.data.products.filter(x => x.projectId === p.id) }; });
  app.post('/api/v1/projects/:projectId/products', async (request, reply) => { const p = project(request); const uid = auth(request); const body = productInput.parse(request.body); const date = now(); const item: Product = { id: store.id(), projectId: p.id, ...body, createdAt: date, updatedAt: date }; await store.commit(db => db.products.push(item)); await audit('product.created', p.id, uid, request.id); return reply.code(201).send(item); });
  app.get('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const item = store.data.products.find(x => x.projectId === p.id && x.id === (request.params as any).productId); if (!item) throw bad('Product not found', 404, 'NOT_FOUND'); return item; });
  app.patch('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const uid = auth(request); const item = store.data.products.find(x => x.projectId === p.id && x.id === (request.params as any).productId); if (!item) throw bad('Product not found', 404, 'NOT_FOUND'); const body = productInput.partial().parse(request.body); Object.assign(item, body, { updatedAt: now() }); await store.commit(db => db); await audit('product.updated', p.id, uid, request.id); return item; });
  app.delete('/api/v1/projects/:projectId/products/:productId', async request => { const p = project(request); const uid = auth(request); const i = store.data.products.findIndex(x => x.projectId === p.id && x.id === (request.params as any).productId); if (i < 0) throw bad('Product not found', 404, 'NOT_FOUND'); const [deleted] = store.data.products.splice(i, 1); await store.commit(db => db); await audit('product.deleted', p.id, uid, request.id); return { deleted: deleted.id }; });
  app.post('/api/v1/projects/:projectId/specifications/versions', async request => { const p = project(request); const uid = auth(request); const body = specInput.parse(request.body); const prior = store.data.specs.filter(x => x.projectId === p.id); const spec = { id: store.id(), projectId: p.id, version: prior.length + 1, schema: body.schema, createdAt: now(), createdBy: uid }; await store.commit(db => db.specs.push(spec)); return spec; });
  app.get('/api/v1/projects/:projectId/specifications/versions', async request => { const p = project(request); return { versions: store.data.specs.filter(x => x.projectId === p.id) }; });
  app.post('/api/v1/projects/:projectId/deployments', async request => { const p = project(request); const uid = auth(request); const b = z.object({ environment: z.enum(['preview','production']), version: z.number().int().positive() }).parse(request.body); if (!store.data.specs.some(s => s.projectId === p.id && s.version === b.version)) throw bad('Specification version not found', 404, 'NOT_FOUND'); const d = { id: store.id(), projectId: p.id, ...b, status: 'active' as const, createdAt: now(), createdBy: uid }; await store.commit(db => { db.deployments.filter(x => x.projectId === p.id && x.environment === b.environment && x.status === 'active').forEach(x => x.status = 'rolled_back'); db.deployments.push(d); }); return d; });
  app.get('/api/v1/projects/:projectId/deployments', async request => { const p = project(request); return { deployments: store.data.deployments.filter(x => x.projectId === p.id) }; });
  app.post('/api/v1/projects/:projectId/snapshots', async request => { const p = project(request); const uid = auth(request); const b = z.object({ reason: z.string().min(1).max(200).default('manual') }).parse(request.body ?? {}); const prior = store.data.snapshots.filter(x => x.projectId === p.id); const state = { specs: store.data.specs.filter(x => x.projectId === p.id) }; const s = { id: store.id(), projectId: p.id, version: prior.length + 1, reason: b.reason, state, createdAt: now(), createdBy: uid }; await store.commit(db => db.snapshots.push(s)); return s; });
  app.get('/api/v1/projects/:projectId/snapshots', async request => { const p = project(request); return { snapshots: store.data.snapshots.filter(x => x.projectId === p.id).map(({ state, ...meta }) => meta) }; });
  app.post('/api/v1/projects/:projectId/snapshots/:snapshotId/rollback', async request => { const p = project(request); const uid = auth(request); const s = store.data.snapshots.find(x => x.projectId === p.id && x.id === (request.params as any).snapshotId); if (!s) throw bad('Snapshot not found', 404, 'NOT_FOUND'); await store.commit(db => { db.specs = db.specs.filter(x => x.projectId !== p.id).concat((s.state as any).specs ?? []); }); await audit('snapshot.rollback', p.id, uid, request.id, { snapshotId: s.id }); return { rolledBackTo: s.id }; });
  app.get('/api/v1/projects/:projectId/audit-logs', async request => { const p = project(request); return { logs: store.data.audits.filter(x => x.projectId === p.id) }; });
  app.get('/api/v1/projects/:projectId/schema', async request => { const p = project(request); const versions = store.data.specs.filter(x => x.projectId === p.id); return { entities: [{ name: 'Product', fields: [{ name: 'name', type: 'string', required: true }, { name: 'sku', type: 'string', required: true }, { name: 'price', type: 'number', required: true }, { name: 'description', type: 'string', required: false }] }], version: versions.at(-1)?.version ?? 0, migrationStatus: 'ready' }; });
  app.post('/api/v1/ai/generate', async request => { auth(request); const { prompt } = z.object({ prompt: z.string().min(1).max(4000) }).parse(request.body); return { provider: ai.name, ...(await ai.generate(prompt)) }; });
  return app;
}
if (process.env.NODE_ENV !== 'test') buildApp().then(app => app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })).catch(err => { console.error(err); process.exit(1); });

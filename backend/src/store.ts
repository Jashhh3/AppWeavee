import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DB } from './types.js';
import pg from 'pg';
import type { Pool as PoolType } from 'pg';
import { readFile as readTextFile } from 'node:fs/promises';

const { Pool } = pg;

export type PoolStatus = { total: number; idle: number; waiting: number };
export type RetryOptions = { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> };
export type StoreOptions = RetryOptions & { pool?: PoolType };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const transientPostgresError = (error: unknown) => {
  const source = error as { code?: string; errno?: string; syscall?: string } | undefined;
  const code = String(source?.code ?? '');
  return ['40001', '40P01', '55P03', '08000', '08001', '08003', '08004', '08006', '08007', '08P01', '57P01', '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code)
    || source?.errno === 'ECONNRESET' || source?.syscall === 'read';
};

/** Retry only transient PostgreSQL failures, preserving the final driver error. */
export async function retryTransient<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const numberOr = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;
  const attempts = Math.max(1, Math.floor(numberOr(options.attempts ?? Number(process.env.DATABASE_RETRY_ATTEMPTS ?? 3), 3)));
  const baseDelayMs = Math.max(0, numberOr(options.baseDelayMs ?? Number(process.env.DATABASE_RETRY_BASE_DELAY_MS ?? 25), 25));
  const maxDelayMs = Math.max(baseDelayMs, numberOr(options.maxDelayMs ?? Number(process.env.DATABASE_RETRY_MAX_DELAY_MS ?? 250), 250));
  const wait = options.sleep ?? sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (!transientPostgresError(error) || attempt === attempts) throw error;
      await wait(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

const empty = (): DB => ({ users: [], userPreferences: [], projects: [], projectSettings: [], providerConfigs: [], products: [], surveyResponses: [], audits: [], specs: [], deployments: [], builds: [], snapshots: [], projectMemory: [], decisions: [], buildHistory: [], graphNodes: [], graphEdges: [], aiBuildDrafts: [], mcpTokens: [], personalAccessTokens: [], oauthClients: [], oauthAuthorizationCodes: [], oauthRefreshTokens: [] });
export class Store {
  private db: DB = empty();
  private writeQueue: Promise<void> = Promise.resolve();
  private pool?: PoolType;
  private lifecycleHandlers?: Array<[NodeJS.Signals | 'uncaughtException' | 'unhandledRejection', (...args: any[]) => void]>;
  constructor(private readonly file: string, private readonly databaseUrl = process.env.DATABASE_URL, private readonly options: StoreOptions = {}) {}
  async load() {
    if (this.databaseUrl) {
      this.pool = this.options.pool ?? new Pool({ connectionString: this.databaseUrl, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
      let migration: string;
      try { migration = await readTextFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'); }
      catch { migration = await readTextFile(new URL('../../migrations/001_initial.sql', import.meta.url), 'utf8'); }
      await this.pool.query(migration);
      const result = await this.pool.query<{ state: DB }>('SELECT state FROM appweave_state WHERE id = 1');
      if (result.rows[0]) this.db = { ...empty(), ...result.rows[0].state };
      else await this.save();
      return this;
    }
    try { this.db = { ...empty(), ...JSON.parse(await readFile(this.file, 'utf8')) }; }
    catch (error) {
      try { await mkdir(dirname(this.file), { recursive: true }); await rename(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* first boot or an unavailable old file */ }
      this.db = empty(); await this.save();
    }
    return this;
  }
  installLifecycleHandlers() {
    if (this.lifecycleHandlers) return;
    const shutdown = async () => { try { await this.flush(); } catch { /* best effort during process shutdown */ } };
    const signal = (signalName: NodeJS.Signals) => { void shutdown().finally(() => process.exit(0)); };
    const fatal = () => { void shutdown().finally(() => process.exit(1)); };
    this.lifecycleHandlers = [['SIGTERM', signal], ['SIGINT', signal], ['uncaughtException', fatal], ['unhandledRejection', fatal]];
    for (const [name, handler] of this.lifecycleHandlers) process.once(name as any, handler as any);
  }
  removeLifecycleHandlers() {
    for (const [name, handler] of this.lifecycleHandlers ?? []) process.removeListener(name as any, handler as any);
    this.lifecycleHandlers = undefined;
  }
  private async save() {
    if (this.pool) {
      await retryTransient(async () => {
        const client = await this.pool!.connect();
        try {
          await client.query('BEGIN');
          await client.query('INSERT INTO appweave_state (id, state, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()', [JSON.stringify(this.db)]);
          for (const u of this.db.users) await client.query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,password_hash=EXCLUDED.password_hash,created_at=EXCLUDED.created_at', [u.id,u.email,u.passwordHash,u.createdAt]);
          for (const p of this.db.projects) await client.query('INSERT INTO projects (id,owner_id,name,environment,public_client_id,preview_url,production_url,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET owner_id=EXCLUDED.owner_id,name=EXCLUDED.name,environment=EXCLUDED.environment,public_client_id=EXCLUDED.public_client_id,preview_url=EXCLUDED.preview_url,production_url=EXCLUDED.production_url,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at', [p.id,p.ownerId,p.name,p.environment,p.publicClientId,p.previewUrl,p.productionUrl,p.createdAt,p.updatedAt]);
          for (const s of this.db.projectSettings) await client.query('INSERT INTO project_settings (project_id,data) VALUES ($1,$2::jsonb) ON CONFLICT (project_id) DO UPDATE SET data=EXCLUDED.data', [s.projectId,JSON.stringify(s)]);
          for (const c of this.db.providerConfigs) await client.query('INSERT INTO provider_configs (id,project_id,provider,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (project_id,provider) DO UPDATE SET id=EXCLUDED.id,data=EXCLUDED.data', [c.id,c.projectId,c.provider,JSON.stringify(c)]);
          for (const r of this.db.surveyResponses) await client.query('INSERT INTO survey_responses (id,project_id,submitted_by,survey_id,answers,consent,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,submitted_by=EXCLUDED.submitted_by,survey_id=EXCLUDED.survey_id,answers=EXCLUDED.answers,consent=EXCLUDED.consent,created_at=EXCLUDED.created_at', [r.id,r.projectId,r.submittedBy,r.surveyId ?? null,JSON.stringify(r.answers),r.consent,r.createdAt]);
          for (const a of this.db.audits) await client.query('INSERT INTO audits (id,project_id,user_id,action,request_id,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,user_id=EXCLUDED.user_id,action=EXCLUDED.action,request_id=EXCLUDED.request_id,metadata=EXCLUDED.metadata,created_at=EXCLUDED.created_at', [a.id,a.projectId ?? null,a.userId ?? null,a.action,a.requestId,JSON.stringify(a.metadata ?? {}),a.createdAt]);
          for (const b of this.db.builds) await client.query('INSERT INTO builds (id,project_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,data=EXCLUDED.data', [b.id,b.projectId,JSON.stringify(b)]);
          for (const d of this.db.deployments) await client.query('INSERT INTO deployments (id,project_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,data=EXCLUDED.data', [d.id,d.projectId,JSON.stringify(d)]);
          for (const v of this.db.snapshots) await client.query('INSERT INTO versions (id,project_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,data=EXCLUDED.data', [v.id,v.projectId,JSON.stringify(v)]);
          const remove = async (table: string, key: string, ids: string[]) => client.query(`DELETE FROM ${table} WHERE ${key}::text <> ALL($1::text[])`, [ids]);
          await remove('users', 'id', this.db.users.map(x => x.id)); await remove('projects', 'id', this.db.projects.map(x => x.id));
          await remove('project_settings', 'project_id', this.db.projectSettings.map(x => x.projectId)); await remove('provider_configs', 'id', this.db.providerConfigs.map(x => x.id));
          await remove('survey_responses', 'id', this.db.surveyResponses.map(x => x.id)); await remove('audits', 'id', this.db.audits.map(x => x.id));
          await remove('builds', 'id', this.db.builds.map(x => x.id)); await remove('deployments', 'id', this.db.deployments.map(x => x.id)); await remove('versions', 'id', this.db.snapshots.map(x => x.id));
          await client.query('COMMIT');
        } catch (error) { try { await client.query('ROLLBACK'); } catch { /* preserve the original transaction error */ } throw error; } finally { client.release(); }
      }, this.options);
      return;
    }
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = join(dirname(this.file), `.${this.file.split(/[\\/]/).pop()}.tmp-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(this.db, null, 2), 'utf8');
    await rename(temporary, this.file);
  }
  get data() { return this.db; }
  poolStatus(): PoolStatus | null { return this.pool ? { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount } : null; }
  getPoolStatus() { return this.poolStatus(); }
  async commit<T>(fn: (db: DB) => T): Promise<T> {
    let result!: T;
    const operation = this.writeQueue.then(async () => {
      result = fn(this.db);
      const limit = Number(process.env.AUDIT_RETENTION_PER_PROJECT ?? 1000);
      if (Number.isFinite(limit) && limit >= 0) {
        const ids = new Set(this.db.audits.map(a => a.projectId).filter((id): id is string => Boolean(id)));
        for (const projectId of ids) {
          const projectAudits = this.db.audits.filter(a => a.projectId === projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          if (projectAudits.length > limit) {
            const remove = new Set(projectAudits.slice(0, projectAudits.length - limit).map(a => a.id));
            this.db.audits = this.db.audits.filter(a => !remove.has(a.id));
          }
        }
      }
      await this.save();
    });
    this.writeQueue = operation;
    await operation;
    return result;
  }
  async flush() { await this.writeQueue; await this.pool?.end(); }
  id() { return randomUUID(); }
}

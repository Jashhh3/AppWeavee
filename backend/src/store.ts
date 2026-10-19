import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DB } from './types.js';
import { Pool } from 'pg';
import { readFile as readTextFile } from 'node:fs/promises';

const empty = (): DB => ({ users: [], userPreferences: [], projects: [], projectSettings: [], providerConfigs: [], products: [], surveyResponses: [], audits: [], specs: [], deployments: [], builds: [], snapshots: [], projectMemory: [], decisions: [], buildHistory: [], graphNodes: [], graphEdges: [], aiBuildDrafts: [], mcpTokens: [], personalAccessTokens: [], oauthClients: [], oauthAuthorizationCodes: [], oauthRefreshTokens: [] });
export class Store {
  private db: DB = empty();
  private writeQueue: Promise<void> = Promise.resolve();
  private pool?: Pool;
  constructor(private readonly file: string, private readonly databaseUrl = process.env.DATABASE_URL) {}
  async load() {
    if (this.databaseUrl) {
      this.pool = new Pool({ connectionString: this.databaseUrl, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
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
  private async save() {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO appweave_state (id, state, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()', [JSON.stringify(this.db)]);
        await client.query('DELETE FROM users; DELETE FROM projects; DELETE FROM project_settings; DELETE FROM provider_configs; DELETE FROM survey_responses; DELETE FROM audits; DELETE FROM sessions_tokens; DELETE FROM builds; DELETE FROM deployments; DELETE FROM versions;');
        for (const u of this.db.users) await client.query('INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)', [u.id,u.email,u.passwordHash,u.createdAt]);
        for (const p of this.db.projects) await client.query('INSERT INTO projects (id,owner_id,name,environment,public_client_id,preview_url,production_url,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [p.id,p.ownerId,p.name,p.environment,p.publicClientId,p.previewUrl,p.productionUrl,p.createdAt,p.updatedAt]);
        for (const s of this.db.projectSettings) await client.query('INSERT INTO project_settings (project_id,data) VALUES ($1,$2::jsonb)', [s.projectId,JSON.stringify(s)]);
        for (const c of this.db.providerConfigs) await client.query('INSERT INTO provider_configs (id,project_id,provider,data) VALUES ($1,$2,$3,$4::jsonb)', [c.id,c.projectId,c.provider,JSON.stringify(c)]);
        for (const r of this.db.surveyResponses) await client.query('INSERT INTO survey_responses (id,project_id,submitted_by,survey_id,answers,consent,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)', [r.id,r.projectId,r.submittedBy,r.surveyId ?? null,JSON.stringify(r.answers),r.consent,r.createdAt]);
        for (const a of this.db.audits) await client.query('INSERT INTO audits (id,project_id,user_id,action,request_id,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)', [a.id,a.projectId ?? null,a.userId ?? null,a.action,a.requestId,JSON.stringify(a.metadata ?? {}),a.createdAt]);
        for (const t of [...this.db.personalAccessTokens, ...this.db.mcpTokens]) await client.query('INSERT INTO sessions_tokens (id,user_id,kind,token_hash,created_at,revoked_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [t.id,t.userId,'token',t.tokenHash,t.createdAt,t.revokedAt ?? null,JSON.stringify(t)]);
        for (const b of this.db.builds) await client.query('INSERT INTO builds (id,project_id,data) VALUES ($1,$2,$3::jsonb)', [b.id,b.projectId,JSON.stringify(b)]);
        for (const d of this.db.deployments) await client.query('INSERT INTO deployments (id,project_id,data) VALUES ($1,$2,$3::jsonb)', [d.id,d.projectId,JSON.stringify(d)]);
        for (const v of this.db.snapshots) await client.query('INSERT INTO versions (id,project_id,data) VALUES ($1,$2,$3::jsonb)', [v.id,v.projectId,JSON.stringify(v)]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      return;
    }
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = join(dirname(this.file), `.${this.file.split(/[\\/]/).pop()}.tmp-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(this.db, null, 2), 'utf8');
    await rename(temporary, this.file);
  }
  get data() { return this.db; }
  async commit<T>(fn: (db: DB) => T): Promise<T> {
    let result!: T;
    const operation = this.writeQueue.then(async () => { result = fn(this.db); await this.save(); });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }
  async flush() { await this.writeQueue; await this.pool?.end(); }
  id() { return randomUUID(); }
}

import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

export type ProjectDatabaseResource = {
  projectId: string;
  database: string;
  role: string;
  schemaVersion: number;
  kind: 'postgres-database';
};

const VERSION = 1;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function resourceFor(projectId: string): ProjectDatabaseResource {
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.includes('\0') || projectId.length > 4096) {
    throw new Error('A non-empty project ID of at most 4096 characters is required.');
  }
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 48);
  return { projectId, database: `aw_db_${hash}`, role: `aw_role_${hash}`, schemaVersion: VERSION, kind: 'postgres-database' };
}

function validate(resource: ProjectDatabaseResource): void {
  if (!object(resource)) throw new Error('Invalid project database resource.');
  const expected = resourceFor(resource.projectId);
  if (resource.database !== expected.database || resource.role !== expected.role ||
      resource.kind !== expected.kind || resource.schemaVersion !== VERSION) {
    throw new Error('Invalid project database resource or unsupported schema version.');
  }
}

function safeError(operation: string, error: unknown): Error {
  // Never propagate driver messages, connection strings, SQL, or state payloads.
  const code = object(error) && typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : undefined;
  return new Error(`Project database ${operation} failed${code ? ` (SQLSTATE ${code})` : ''}. Check platform PostgreSQL permissions and database availability.`);
}

/**
 * The connection is a trusted platform superuser, never exposed to project code.
 * Superuser is required so SET ROLE works without giving project roles membership
 * in one another (including across PostgreSQL versions). No role is a DB owner.
 */
export class ProjectDatabaseManager {
  private readonly admin: Pool;
  private readonly pools = new Map<string, Pool>();
  private readonly url: URL;
  private closed = false;

  constructor(databaseUrl: string) {
    try {
      this.url = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(this.url.protocol)) throw new Error();
      // libpq's dbname override could otherwise defeat the database in the path.
      if ([...this.url.searchParams.keys()].some(key => ['database', 'dbname', 'user', 'password', 'options'].includes(key.toLowerCase()))) throw new Error();
    } catch { throw new Error('A valid PostgreSQL platform connection URL is required.'); }
    this.admin = new pg.Pool({ connectionString: this.url.toString() });
  }

  private pool(resource: ProjectDatabaseResource): Pool {
    if (this.closed) throw new Error('Project database manager is closed.');
    let pool = this.pools.get(resource.database);
    if (!pool) {
      const url = new URL(this.url);
      url.pathname = `/${resource.database}`;
      pool = new pg.Pool({ connectionString: url.toString() });
      this.pools.set(resource.database, pool);
    }
    return pool;
  }

  async provision(projectId: string): Promise<ProjectDatabaseResource> {
    const resource = resourceFor(projectId);
    if (this.closed) throw new Error('Project database manager is closed.');
    let client: PoolClient | undefined;
    let locked = false;
    let discard = false;
    const role = identifier(resource.role);
    const database = identifier(resource.database);
    try {
      client = await this.admin.connect();
      const permission = await client.query<{ username: string; allowed: boolean }>(
        'SELECT current_user AS username, rolsuper AS allowed FROM pg_roles WHERE rolname = current_user');
      if (!permission.rows[0]?.allowed) {
        throw new Error('Platform provisioning requires a PostgreSQL superuser (CREATE DATABASE, CREATE ROLE, ownership and SET ROLE permissions).');
      }
      const owner = permission.rows[0].username;
      // Session lock: CREATE DATABASE is forbidden inside a transaction. All
      // instances use their central connection to serialize retries per project.
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [resource.database]);
      locked = true;
      const existingRole = await client.query('SELECT oid FROM pg_roles WHERE rolname = $1', [resource.role]);
      if (!existingRole.rows.length) await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      const unsafe = await client.query(`SELECT 1 FROM pg_roles r WHERE r.rolname = $1 AND
        (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls
         OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))`, [resource.role]);
      if (unsafe.rows.length) throw new Error('Unsafe existing project role.');
      // Central state must not be exposed through accidental PUBLIC privileges.
      const central = await client.query(`SELECT has_table_privilege($1, c.oid, 'SELECT') AS readable
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'appweave_state' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`, [resource.role]);
      if (central.rows.some(row => row.readable)) throw new Error('Central state is accessible to the project role.');
      const existingDb = await client.query<{ owner: string }>(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [resource.database]);
      if (!existingDb.rows.length) {
        await client.query(`CREATE DATABASE ${database} OWNER ${identifier(owner)} TEMPLATE template0`);
      } else if (existingDb.rows[0].owner !== owner) {
        throw new Error('Existing project database is not owned by the platform provisioning user.');
      }
      // Repeat these operations on retries, including after CREATE DATABASE has
      // succeeded but a later migration or smoke check failed.
      await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON DATABASE ${database} FROM ${role}`);
      await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
      await this.migrate(resource);
      await this.smoke(resource);
      return resource;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Platform provisioning requires')) throw error;
      throw safeError('provisioning', error);
    } finally {
      if (client && locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [resource.database]); }
        catch { discard = true; }
      }
      client?.release(discard);
    }
  }

  private async transaction<T>(resource: ProjectDatabaseResource, scoped: boolean, commit: boolean, run: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    let discard = false;
    try {
      client = await this.pool(resource).connect();
      await client.query('BEGIN');
      if (scoped) await client.query(`SET LOCAL ROLE ${identifier(resource.role)}`);
      const result = await run(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      }
      throw safeError('transaction', error);
    } finally { client?.release(discard); }
  }

  private async migrate(resource: ProjectDatabaseResource): Promise<void> {
    await this.transaction(resource, false, true, async client => {
      const role = identifier(resource.role);
      await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await client.query('CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION CURRENT_USER');
      await client.query('REVOKE ALL ON SCHEMA app FROM PUBLIC');
      await client.query(`REVOKE ALL ON SCHEMA app FROM ${role}`);
      await client.query(`CREATE TABLE IF NOT EXISTS app.schema_migrations (
        version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const version = await client.query<{ version: number }>('SELECT version FROM app.schema_migrations ORDER BY version DESC LIMIT 1');
      if (version.rows.length && version.rows[0].version !== VERSION) throw new Error('Unsupported database schema version.');
      await client.query(`CREATE TABLE IF NOT EXISTS app.state (
        id integer PRIMARY KEY CHECK (id = 1),
        state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'))`);
      await client.query("INSERT INTO app.state (id, state) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
      await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC');
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA app FROM ${role}`);
      await client.query(`GRANT USAGE ON SCHEMA app TO ${role}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON app.state TO ${role}`);
      await client.query('INSERT INTO app.schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [VERSION]);
    });
  }

  private async smoke(resource: ProjectDatabaseResource): Promise<void> {
    await this.transaction(resource, true, false, async client => {
      await client.query('SELECT state FROM app.state WHERE id = 1 FOR UPDATE');
      await client.query('DELETE FROM app.state WHERE id = 1');
      await client.query('INSERT INTO app.state (id, state) VALUES (1, $1::jsonb)', [JSON.stringify({ smoke: true })]);
      await client.query('UPDATE app.state SET state = $1::jsonb WHERE id = 1', [JSON.stringify({ smoke: 'updated' })]);
      const result = await client.query('SELECT state FROM app.state WHERE id = 1');
      if (result.rows[0]?.state?.smoke !== 'updated') throw new Error('Project state smoke check failed.');
    });
  }

  async write(resource: ProjectDatabaseResource, state: Record<string, unknown>): Promise<void> {
    validate(resource);
    if (!object(state)) throw new Error('Project state must be a JSON object.');
    let json: string;
    try {
      json = JSON.stringify(state);
      if (!object(JSON.parse(json))) throw new Error();
    } catch { throw new Error('Project state must be a serializable JSON object.'); }
    await this.transaction(resource, true, true, async client => {
      await client.query(`INSERT INTO app.state (id, state) VALUES (1, $1::jsonb)
        ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state`, [json]);
    });
  }

  async read(resource: ProjectDatabaseResource): Promise<Record<string, unknown>> {
    validate(resource);
    return this.transaction(resource, true, true, async client => {
      const result = await client.query('SELECT state FROM app.state WHERE id = 1');
      if (!result.rows.length) return {};
      if (!object(result.rows[0].state)) throw new Error('Invalid stored project state.');
      return result.rows[0].state;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pools = [this.admin, ...this.pools.values()];
    this.pools.clear();
    try { await Promise.all(pools.map(pool => pool.end())); }
    catch (error) { throw safeError('shutdown', error); }
  }
}

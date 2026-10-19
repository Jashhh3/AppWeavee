import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pools: [] as any[] }));
vi.mock('pg', () => ({ default: { Pool: vi.fn(function (options) {
  const pool: any = {
    options,
    query: vi.fn(async (sql: string) => {
      if (sql.includes('rolsuper AS allowed')) return { rows: [{ username: 'platform', allowed: true }] };
      if (sql === 'SELECT state FROM app.state WHERE id = 1') return { rows: [{ state: { smoke: 'updated' } }] };
      return { rows: [] };
    }),
    release: vi.fn(), end: vi.fn(async () => {}),
  };
  pool.connect = vi.fn(async () => ({ query: pool.query, release: pool.release }));
  mocks.pools.push(pool);
  return pool;
}) } }));

import { ProjectDatabaseManager, type ProjectDatabaseResource } from '../src/project-database.js';

const url = 'postgresql://platform:secret-password@localhost:5432/central?sslmode=require';
const resourceFor = (projectId: string): ProjectDatabaseResource => {
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 48);
  return { projectId, database: `aw_db_${hash}`, role: `aw_role_${hash}`, kind: 'postgres-database', schemaVersion: 1 };
};
const sqls = (pool: any): string[] => pool.query.mock.calls.map(([sql]: [string]) => sql);

describe('ProjectDatabaseManager', () => {
  beforeEach(() => { mocks.pools.length = 0; vi.clearAllMocks(); });

  it('provisions deterministic, bounded identifiers, platform ownership and narrow grants', async () => {
    const manager = new ProjectDatabaseManager(url);
    const id = 'tenant"; DROP DATABASE central; -- 💾'.repeat(20);
    const result = await manager.provision(id);
    expect(result).toEqual(resourceFor(id));
    expect(result.database).toMatch(/^aw_db_[a-f0-9]{48}$/);
    expect(result.role).toMatch(/^aw_role_[a-f0-9]{48}$/);
    expect(Buffer.byteLength(result.role)).toBeLessThanOrEqual(63);
    expect(JSON.stringify(result)).not.toContain('secret-password');
    const [admin, project] = mocks.pools;
    const ddl = sqls(admin).join('\n');
    expect(ddl).toContain(`CREATE ROLE "${result.role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    expect(ddl).toContain(`CREATE DATABASE "${result.database}" OWNER "platform" TEMPLATE template0`);
    expect(ddl).toContain(`REVOKE ALL ON DATABASE "${result.database}" FROM PUBLIC`);
    expect(ddl).toContain(`GRANT CONNECT ON DATABASE "${result.database}" TO "${result.role}"`);
    expect(ddl).not.toContain(id);
    expect(ddl).not.toMatch(/GRANT .* TO "platform"/);
    const projectUrl = new URL(project.options.connectionString);
    expect(projectUrl.pathname).toBe(`/${result.database}`);
    expect(projectUrl.username).toBe('platform');
    expect(projectUrl.searchParams.get('sslmode')).toBe('require');
    const queries = sqls(project);
    expect(queries).toContain('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    expect(queries).toContain(`REVOKE ALL ON SCHEMA public FROM "${result.role}"`);
    expect(queries).toContain(`GRANT USAGE ON SCHEMA app TO "${result.role}"`);
    expect(queries).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON app.state TO "${result.role}"`);
    expect(queries.join('\n')).toContain('CHECK (id = 1)');
    expect(queries.join('\n')).toContain("jsonb_typeof(state) = 'object'");
    expect(queries).toContain('INSERT INTO app.schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING');
    expect(queries).toContain(`SET LOCAL ROLE "${result.role}"`);
    expect(queries.slice(-7)).toEqual([
      `SET LOCAL ROLE "${result.role}"`,
      'SELECT state FROM app.state WHERE id = 1 FOR UPDATE',
      'DELETE FROM app.state WHERE id = 1',
      'INSERT INTO app.state (id, state) VALUES (1, $1::jsonb)',
      'UPDATE app.state SET state = $1::jsonb WHERE id = 1',
      'SELECT state FROM app.state WHERE id = 1', 'ROLLBACK',
    ]);
    expect(sqls(admin).at(-1)).toContain('pg_advisory_unlock');
    await manager.close();
  });

  it('retries a partially completed provision without recreating the database or erasing state', async () => {
    const manager = new ProjectDatabaseManager(url);
    const admin = mocks.pools[0];
    const defaultQuery = admin.query.getMockImplementation();
    let exists = false;
    admin.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT oid FROM pg_roles')) return { rows: exists ? [{ oid: 10 }] : [] };
      if (sql.includes('SELECT pg_get_userbyid')) return { rows: exists ? [{ owner: 'platform' }] : [] };
      if (sql.startsWith('CREATE DATABASE')) { exists = true; return { rows: [] }; }
      if (sql.startsWith('GRANT CONNECT') && admin.query.mock.calls.filter(([s]: [string]) => s.startsWith('GRANT CONNECT')).length === 1) {
        throw { code: '08006', message: url };
      }
      return defaultQuery(sql);
    });
    await expect(manager.provision('retry')).rejects.toThrow('SQLSTATE 08006');
    const resource = await manager.provision('retry');
    expect(resource).toEqual(resourceFor('retry'));
    expect(sqls(admin).filter(sql => sql.startsWith('CREATE DATABASE'))).toHaveLength(1);
    expect(sqls(admin).filter(sql => sql.startsWith('CREATE ROLE'))).toHaveLength(1);
    expect(sqls(mocks.pools[1]).join('\n')).toContain('ON CONFLICT (id) DO NOTHING');
    expect(admin.release).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it('scopes every read/write inside its own transaction and parameterizes JSON state', async () => {
    const manager = new ProjectDatabaseManager(url);
    const a = resourceFor('A');
    const b = resourceFor('B');
    const state = { text: "'); DROP SCHEMA app; --", nested: [true, 5] };
    await manager.write(a, state);
    const project = mocks.pools[1];
    expect(sqls(project)[0]).toBe('BEGIN');
    expect(sqls(project)[1]).toBe(`SET LOCAL ROLE "${a.role}"`);
    expect(project.query.mock.calls[2][1]).toEqual([JSON.stringify(state)]);
    expect(sqls(project).at(-1)).toBe('COMMIT');
    project.query.mockResolvedValue({ rows: [{ state }] });
    expect(await manager.read(a)).toEqual(state);
    expect(sqls(project).slice(-4)).toEqual(['BEGIN', `SET LOCAL ROLE "${a.role}"`, 'SELECT state FROM app.state WHERE id = 1', 'COMMIT']);
    await manager.read(b);
    expect(mocks.pools).toHaveLength(3);
    expect(new URL(mocks.pools[2].options.connectionString).pathname).toBe(`/${b.database}`);
    expect(sqls(mocks.pools[2])[1]).toBe(`SET LOCAL ROLE "${b.role}"`);
    expect(project.release).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it.each(['database', 'role', 'schemaVersion', 'kind'] as const)('rejects a forged %s before opening a connection', async key => {
    const manager = new ProjectDatabaseManager(url);
    const resource: any = { ...resourceFor('A'), [key]: key === 'schemaVersion' ? 2 : 'forged"; SELECT 1' };
    await expect(manager.read(resource)).rejects.toThrow('Invalid project database resource');
    await expect(manager.write(resource, {})).rejects.toThrow('Invalid project database resource');
    expect(mocks.pools).toHaveLength(1);
    expect(mocks.pools[0].connect).not.toHaveBeenCalled();
    await manager.close();
  });

  it('rejects empty IDs and non-object/cyclic JSON without querying', async () => {
    const manager = new ProjectDatabaseManager(url);
    await expect(manager.provision(' ')).rejects.toThrow('project ID');
    await expect(manager.provision('a\0b')).rejects.toThrow('project ID');
    for (const value of [null, [], 1, { toJSON: () => [] }, { value: 1n }]) {
      await expect(manager.write(resourceFor('A'), value as any)).rejects.toThrow('JSON object');
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(manager.write(resourceFor('A'), cycle)).rejects.toThrow('serializable');
    expect(mocks.pools).toHaveLength(1);
    await manager.close();
  });

  it.each(['SET LOCAL ROLE', 'INSERT INTO app.state', 'COMMIT'])('rolls back failures at %s without leaking secrets', async failure => {
    const manager = new ProjectDatabaseManager(url);
    // Create a pool with a first successful request.
    const resource = resourceFor('A');
    await manager.read(resource);
    const pool = mocks.pools[1];
    pool.query.mockClear();
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith(failure)) throw { code: '42501', message: `${url} private-state` };
      return { rows: [] };
    });
    let message = '';
    try { await manager.write(resource, { secret: 'private-state' }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('SQLSTATE 42501');
    expect(message).not.toContain('secret-password');
    expect(message).not.toContain('private-state');
    expect(sqls(pool).at(-1)).toBe('ROLLBACK');
    expect(pool.release).toHaveBeenLastCalledWith(false);
    await manager.close();
  });

  it('discards a connection when rollback fails', async () => {
    const manager = new ProjectDatabaseManager(url);
    const resource = resourceFor('A');
    await manager.read(resource);
    const pool = mocks.pools[1];
    pool.query.mockRejectedValue(new Error(url));
    await expect(manager.read(resource)).rejects.toThrow('transaction failed');
    expect(pool.release).toHaveBeenLastCalledWith(true);
    await manager.close();
  });

  it('requires explicit platform privileges and validates preexisting role isolation', async () => {
    const manager = new ProjectDatabaseManager(url);
    const admin = mocks.pools[0];
    admin.query.mockResolvedValueOnce({ rows: [{ username: 'limited', allowed: false }] });
    await expect(manager.provision('A')).rejects.toThrow('requires a PostgreSQL superuser');
    expect(sqls(admin)).toHaveLength(1);
    const defaultQuery = admin.query.getMockImplementation();
    admin.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT 1 FROM pg_roles r')) return { rows: [{ unsafe: true }] };
      return defaultQuery(sql);
    });
    await expect(manager.provision('A')).rejects.toThrow('provisioning failed');
    expect(sqls(admin).some(sql => sql.includes('m.member = r.oid'))).toBe(true);
    expect(sqls(admin).some(sql => sql.startsWith('CREATE DATABASE'))).toBe(false);
    await manager.close();
  });

  it('refuses provision when the role can read central state', async () => {
    const manager = new ProjectDatabaseManager(url);
    const admin = mocks.pools[0];
    const defaultQuery = admin.query.getMockImplementation();
    admin.query.mockImplementation(async (sql: string) => sql.includes('has_table_privilege')
      ? { rows: [{ readable: true }] } : defaultQuery(sql));
    await expect(manager.provision('A')).rejects.toThrow('provisioning failed');
    expect(sqls(admin).some(sql => sql.startsWith('CREATE DATABASE'))).toBe(false);
    await manager.close();
  });

  it('rejects a database owned by a project role', async () => {
    const manager = new ProjectDatabaseManager(url);
    const admin = mocks.pools[0];
    const defaultQuery = admin.query.getMockImplementation();
    admin.query.mockImplementation(async (sql: string) => sql.includes('SELECT pg_get_userbyid')
      ? { rows: [{ owner: resourceFor('A').role }] } : defaultQuery(sql));
    await expect(manager.provision('A')).rejects.toThrow('provisioning failed');
    expect(mocks.pools).toHaveLength(1);
    await manager.close();
  });

  it('rolls back unsupported migrations and unlocks provisioning', async () => {
    const manager = new ProjectDatabaseManager(url);
    const resource = resourceFor('A');
    await manager.read(resource);
    const project = mocks.pools[1];
    const defaultQuery = project.query.getMockImplementation();
    project.query.mockImplementation(async (sql: string) => sql.startsWith('SELECT version')
      ? { rows: [{ version: 99 }] } : defaultQuery(sql));
    await expect(manager.provision('A')).rejects.toThrow('provisioning failed');
    expect(sqls(project).at(-1)).toBe('ROLLBACK');
    expect(sqls(mocks.pools[0]).at(-1)).toContain('pg_advisory_unlock');
    await manager.close();
  });

  it('rejects URL overrides and sanitizes invalid URLs', () => {
    for (const invalid of ['secret-password', 'https://localhost', `${url}&database=central`, `${url}&options=-crole=admin`]) {
      expect(() => new ProjectDatabaseManager(invalid)).toThrow('valid PostgreSQL platform connection URL');
    }
    expect(mocks.pools).toHaveLength(0);
  });

  it('closes all pools once and rejects further operations', async () => {
    const manager = new ProjectDatabaseManager(url);
    await manager.read(resourceFor('A'));
    await manager.read(resourceFor('B'));
    await manager.close();
    await manager.close();
    for (const pool of mocks.pools) expect(pool.end).toHaveBeenCalledTimes(1);
    await expect(manager.read(resourceFor('A'))).rejects.toThrow('transaction failed');
    await expect(manager.provision('A')).rejects.toThrow('closed');
  });
});

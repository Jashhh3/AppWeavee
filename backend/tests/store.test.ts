import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

describe('Store lifecycle and retention', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); process.env.AUDIT_RETENTION_PER_PROJECT = ''; });
  it('bounds audit history per project and preserves write failures', async () => {
    dir = await mkdtemp(join(tmpdir(), 'appweave-store-'));
    process.env.AUDIT_RETENTION_PER_PROJECT = '2';
    const store = await new Store(join(dir, 'db.json')).load();
    const projectId = 'project-retention';
    await store.commit(db => { db.audits.push(...[1, 2, 3].map(n => ({ id: String(n), projectId, action: 'test', requestId: String(n), metadata: {}, createdAt: `2026-01-0${n}T00:00:00.000Z` }))); });
    expect(store.data.audits.map(a => a.id)).toEqual(['2', '3']);
    await expect(store.commit(() => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    await expect(store.flush()).rejects.toThrow('write failed');
  });
});

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, retryTransient } from '../src/store.js';

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

  it('retries transient database errors with bounded backoff and preserves exhaustion errors', async () => {
    let calls = 0;
    const waits: number[] = [];
    await expect(retryTransient(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('serialization'), { code: '40001' });
      return 'saved';
    }, { attempts: 3, baseDelayMs: 2, maxDelayMs: 3, sleep: async ms => { waits.push(ms); } })).resolves.toBe('saved');
    expect(calls).toBe(3);
    expect(waits).toEqual([2, 3]);

    const exhausted = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    await expect(retryTransient(async () => { throw exhausted; }, { attempts: 2, baseDelayMs: 0, sleep: async () => {} })).rejects.toBe(exhausted);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    await expect(retryTransient(async () => { calls += 1; throw Object.assign(new Error('constraint'), { code: '23505' }); }, { attempts: 4, sleep: async () => {} })).rejects.toThrow('constraint');
    expect(calls).toBe(1);
  });
});

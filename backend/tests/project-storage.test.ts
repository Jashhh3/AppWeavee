import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureProjectStorage, projectRoot, requireProjectStorage } from '../src/project-storage.js';

describe('authoritative project storage', () => {
  const id = '638857dd-a1c7-49f3-99d8-b52f021497a0';
  it('creates and returns the validated project directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'appweave-storage-'));
    try { await expect(ensureProjectStorage(root, id)).resolves.toBe(projectRoot(root, id)); await writeFile(join(root, id, 'index.html'), 'ok'); await expect(requireProjectStorage(root, id)).resolves.toBe(projectRoot(root, id)); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects missing directories and traversal-shaped IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'appweave-storage-'));
    try { await expect(requireProjectStorage(root, id)).rejects.toThrow('missing'); expect(() => projectRoot(root, '../escape')).toThrow('Invalid project ID'); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});

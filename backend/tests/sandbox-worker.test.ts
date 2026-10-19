import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_LIMITS, runSandboxedViteBuild, sandboxStatus } from '../src/sandbox-worker.js';

const prior = process.env.APPWEAVE_DOCKER_WORKER;
afterEach(() => {
  if (prior === undefined) delete process.env.APPWEAVE_DOCKER_WORKER;
  else process.env.APPWEAVE_DOCKER_WORKER = prior;
});

describe('sandbox worker', () => {
  it('uses the artifact fallback contract when Docker workers are disabled', async () => {
    delete process.env.APPWEAVE_DOCKER_WORKER;
    expect(sandboxStatus().available).toBe(false);
    await expect(runSandboxedViteBuild('/tmp/project', '/tmp/project/dist')).resolves.toMatchObject({
      status: 'unavailable',
      runtime: 'unavailable',
      logs: expect.arrayContaining(['vite worker unavailable; Docker worker is not enabled']),
    });
  });

  it('keeps the documented resource defaults stable', () => {
    expect(DEFAULT_SANDBOX_LIMITS).toEqual({ timeoutMs: 30_000, memoryMb: 512, maxOutputBytes: 2 * 1024 * 1024 });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DEFAULT_SANDBOX_LIMITS, runSandboxedViteBuild, sandboxStatus } from '../src/sandbox-worker.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const prior = process.env.APPWEAVE_DOCKER_WORKER;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  if (prior === undefined) delete process.env.APPWEAVE_DOCKER_WORKER;
  else process.env.APPWEAVE_DOCKER_WORKER = prior;
});

describe('sandbox worker', () => {
  it('reports unavailable rather than ready when Docker workers are disabled', async () => {
    delete process.env.APPWEAVE_DOCKER_WORKER;
    expect(sandboxStatus().available).toBe(false);
    await expect(runSandboxedViteBuild('/tmp/project', '/tmp/project/dist')).resolves.toMatchObject({
      status: 'unavailable',
      runtime: 'unavailable',
      logs: expect.arrayContaining(['vite worker unavailable; Docker worker is not enabled']),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps the documented resource defaults stable', () => {
    expect(DEFAULT_SANDBOX_LIMITS).toEqual({ timeoutMs: 30_000, memoryMb: 512, maxOutputBytes: 2 * 1024 * 1024 });
  });

  it('propagates a nonzero isolated build exit and builds a clean scratch copy before exporting dist', async () => {
    vi.stubEnv('APPWEAVE_DOCKER_WORKER', 'true');
    vi.stubEnv('PROJECT_WORKSPACE_ROOT', '/tmp/projects');
    vi.stubEnv('APPWEAVE_DOCKER_WORKER_VOLUME', '');
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => { child.stderr.emit('data', Buffer.from('vite compilation failed')); child.emit('close', 1); });
      return child as unknown as ReturnType<typeof spawn>;
    });
    const result = await runSandboxedViteBuild('/tmp/projects/example', '/tmp/projects/example/preview/version-1/staged');
    expect(result).toMatchObject({ status: 'failed', runtime: 'docker_worker', error: 'SANDBOX_EXIT_1' });
    expect(result.logs).toContain('vite compilation failed');
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[0]).toBe('run');
    expect(args).not.toContain('--volume');
    expect(args[args.indexOf('--mount') + 1]).toBe('type=bind,source=/tmp/projects/example,target=/workspace');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/workspace');
    const command = args[args.length - 1];
    expect(command).toContain('--exclude=./dist');
    expect(command).toContain('cd /tmp/build');
    expect(command).toContain('if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; else npm install --ignore-scripts --no-audit --no-fund; fi;');
    expect(command).toContain('npm run build -- --base=./; test -s dist/index.html');
    expect(command).toContain("cp -a dist/. '/workspace/preview/version-1/staged'/");
  });

  function mockNamedVolume(inspectionExit = 0, runExit = 0, versions = '1.45 1.45') {
    vi.stubEnv('APPWEAVE_DOCKER_WORKER', 'true');
    vi.stubEnv('PROJECT_WORKSPACE_ROOT', '/data/projects');
    vi.stubEnv('APPWEAVE_DOCKER_WORKER_VOLUME', 'existing_appweave-projects');
    vi.stubEnv('DOCKER_API_VERSION', '');
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
      queueMicrotask(() => {
        if (args?.[0] === 'version') child.stdout.emit('data', Buffer.from(versions));
        child.emit('close', args?.[0] === 'version' ? 0 : args?.[0] === 'volume' ? inspectionExit : runExit);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
  }

  it('inspects the existing named volume and exposes only the selected project subpath', async () => {
    mockNamedVolume();
    for (const project of ['first-project', 'second-project']) {
      await expect(runSandboxedViteBuild(`/data/projects/${project}`, `/data/projects/${project}/preview/staged`)).resolves.toMatchObject({ status: 'ready' });
    }
    const calls = vi.mocked(spawn).mock.calls;
    expect(calls[0][1]).toEqual(['version', '--format', '{{.Server.APIVersion}} {{.Client.APIVersion}}']);
    expect(calls[1].slice(0, 2)).toEqual(['docker', ['volume', 'inspect', 'existing_appweave-projects']]);
    for (const [index, project] of [[2, 'first-project'], [5, 'second-project']] as const) {
      const args = calls[index][1] as string[];
      expect(args.filter(value => value === '--mount')).toHaveLength(1);
      expect(args).not.toContain('--volume');
      expect(args[args.indexOf('--mount') + 1]).toBe(`type=volume,source=existing_appweave-projects,target=/workspace,volume-subpath=${project},volume-nocopy`);
      expect(args[args.indexOf('--workdir') + 1]).toBe('/workspace');
      expect(args[args.length - 1]).toContain("cp -a dist/. '/workspace/preview/staged'/");
    }
  });

  it('fails closed when the configured named volume does not exist without creating it or launching a worker', async () => {
    mockNamedVolume(1);
    await expect(runSandboxedViteBuild('/data/projects/first', '/data/projects/first/preview/staged')).resolves.toMatchObject({ status: 'failed', error: 'SANDBOX_VOLUME_UNAVAILABLE' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1][1]).toEqual(['volume', 'inspect', 'existing_appweave-projects']);
  });

  it('fails closed on unsupported volume-subpath with no retry using the whole volume', async () => {
    mockNamedVolume(0, 125);
    await expect(runSandboxedViteBuild('/data/projects/first', '/data/projects/first/preview/staged')).resolves.toMatchObject({ status: 'failed', error: 'SANDBOX_EXIT_125' });
    expect(spawn).toHaveBeenCalledTimes(3);
    expect((vi.mocked(spawn).mock.calls[2][1] as string[]).join(' ')).toContain('volume-subpath=first');
  });

  it.each(['1.44 1.45', '1.45 1.44', '', 'unknown'])('refuses unsupported or unverified Docker API versions (%s) before mounting anything', async versions => {
    mockNamedVolume(0, 0, versions);
    await expect(runSandboxedViteBuild('/data/projects/first', '/data/projects/first/preview/staged')).resolves.toMatchObject({ status: 'failed', error: 'SANDBOX_SUBPATH_UNSUPPORTED' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses a forced legacy API even when the Docker daemon supports subpaths', async () => {
    mockNamedVolume();
    vi.stubEnv('DOCKER_API_VERSION', '1.44');
    await expect(runSandboxedViteBuild('/data/projects/first', '/data/projects/first/preview/staged')).resolves.toMatchObject({ status: 'failed', error: 'SANDBOX_SUBPATH_UNSUPPORTED' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses mount-option injection before invoking Docker', async () => {
    mockNamedVolume();
    await expect(runSandboxedViteBuild('/data/projects/first,volume-subpath=../second', '/data/projects/first,volume-subpath=../second/preview/staged')).resolves.toMatchObject({ status: 'failed', error: 'UNSAFE_PROJECT_PATH' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

import { spawn } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SandboxLimits = { timeoutMs: number; memoryMb: number; maxOutputBytes: number };
export type SandboxResult = { status: 'ready' | 'unavailable' | 'failed'; runtime: 'docker_worker' | 'unavailable'; logs: string[]; error?: string };
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { timeoutMs: 30_000, memoryMb: 512, maxOutputBytes: 2 * 1024 * 1024 };

/** The API only launches Docker; generated npm/Vite code runs in this separate container. */
export function sandboxStatus() {
  const available = process.env.APPWEAVE_DOCKER_WORKER === 'true';
  return { available, runtime: available ? 'docker_worker' as const : 'unavailable' as const, limits: DEFAULT_SANDBOX_LIMITS };
}

function boundedAppend(value: { text: string; bytes: number; truncated: boolean }, chunk: Buffer, max: number) {
  if (value.bytes >= max) { value.truncated = true; return; }
  const remaining = max - value.bytes;
  const text = chunk.subarray(0, remaining).toString('utf8');
  value.text += text;
  value.bytes += Buffer.byteLength(text);
  if (chunk.byteLength > remaining) value.truncated = true;
}

export async function runSandboxedViteBuild(root: string, out: string, limits = DEFAULT_SANDBOX_LIMITS): Promise<SandboxResult> {
  const status = sandboxStatus();
  const limitsLog = `worker limits: timeout=${limits.timeoutMs}ms memory=${limits.memoryMb}MiB output=${limits.maxOutputBytes} bytes`;
  if (!status.available) return { status: 'unavailable', runtime: 'unavailable', logs: ['vite worker unavailable; Docker worker is not enabled', limitsLog] };

  const workspace = resolve(process.env.PROJECT_WORKSPACE_ROOT ?? dirname(resolve(root)));
  const projectPath = resolve(root);
  const projectRelative = relative(workspace, projectPath).replaceAll('\\', '/');
  const outputRelative = relative(projectPath, resolve(out)).replaceAll('\\', '/');
  if (!projectRelative || isAbsolute(projectRelative) || projectRelative.startsWith('../') || projectRelative === '..' || /[\0,\r\n"\\]/.test(projectRelative)) {
    return { status: 'failed', runtime: 'docker_worker', logs: ['worker refused an unsafe project path'], error: 'UNSAFE_PROJECT_PATH' };
  }
  const volume = process.env.APPWEAVE_DOCKER_WORKER_VOLUME;
  const image = process.env.APPWEAVE_DOCKER_WORKER_IMAGE ?? 'node:20.15.1-bookworm-slim';
  if ((volume && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume)) || /[,\r\n"\0]/.test(projectPath)) {
    return { status: 'failed', runtime: 'docker_worker', logs: ['worker refused an unsafe mount'], error: 'UNSAFE_PROJECT_MOUNT' };
  }
  // Never mount the workspace root: generated code can access only this project.
  // Docker Engine 26+ is required for volume-subpath; unsupported engines fail
  // the run without retrying with a broader mount.
  const mount = volume
    ? `type=volume,source=${volume},target=/workspace,volume-subpath=${projectRelative},volume-nocopy`
    : `type=bind,source=${projectPath},target=/workspace`;
  if (!outputRelative || isAbsolute(outputRelative) || outputRelative.includes('\0') || outputRelative.startsWith('../') || outputRelative === '..') return { status: 'failed', runtime: 'docker_worker', logs: ['worker refused an unsafe output path'], error: 'UNSAFE_OUTPUT_PATH' };
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const source = '/workspace';
  const destination = `${source}/${outputRelative}`;
  // Build a clean scratch copy: stale root dist must not turn a no-op build into success.
  const command = `set -eu; mkdir -p /tmp/build; tar --exclude=./node_modules --exclude=./dist --exclude=./preview --exclude=./production --exclude=./.git -cf /tmp/source.tar .; tar -xf /tmp/source.tar -C /tmp/build; cd /tmp/build; export npm_config_cache=/tmp/npm-cache; if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; else npm install --ignore-scripts --no-audit --no-fund; fi; npm run build -- --base=./; test -s dist/index.html; mkdir -p ${quote(destination)}; cp -a dist/. ${quote(destination)}/`;
  const containerName = `appweave-build-${randomUUID()}`;
  const args = ['run', '--name', containerName, '--rm', '--init', '--memory', `${limits.memoryMb}m`, '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=512m', '--mount', mount, '--workdir', source, image, 'sh', '-lc', command];
  if (volume) {
    // Old daemons may ignore unknown API fields. Check both daemon and CLI API
    // versions explicitly instead of relying on Docker to reject the mount.
    const compatibility = await new Promise<SandboxResult | undefined>(resolveCheck => {
      const versionOutput = { text: '', bytes: 0, truncated: false };
      let check;
      try { check = spawn('docker', ['version', '--format', '{{.Server.APIVersion}} {{.Client.APIVersion}}'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { resolveCheck({ status: 'unavailable', runtime: 'unavailable', logs: ['Docker CLI could not be started', limitsLog], error: 'SANDBOX_WORKER_UNAVAILABLE' }); return; }
      check.stdout.on('data', chunk => boundedAppend(versionOutput, chunk, 256));
      const timer = setTimeout(() => check.kill('SIGKILL'), limits.timeoutMs);
      check.on('error', () => { clearTimeout(timer); resolveCheck({ status: 'unavailable', runtime: 'unavailable', logs: ['Docker API version check unavailable', limitsLog], error: 'SANDBOX_WORKER_UNAVAILABLE' }); });
      check.on('close', code => {
        clearTimeout(timer);
        const versions = versionOutput.text.trim().split(/\s+/);
        const supported = (value: string) => /^1\.\d+$/.test(value) && Number(value.split('.')[1]) >= 45;
        const forcedApi = process.env.DOCKER_API_VERSION;
        resolveCheck(code === 0 && !versionOutput.truncated && versions.length === 2 && versions.every(supported) && (!forcedApi || supported(forcedApi)) ? undefined : { status: 'failed', runtime: 'docker_worker', logs: ['Named-volume workers require Docker Engine 26.0+ and CLI API 1.45+ for volume-subpath; refusing an unrestricted mount', limitsLog], error: 'SANDBOX_SUBPATH_UNSUPPORTED' });
      });
    });
    if (compatibility) return compatibility;
    // --mount can create a missing volume. Refuse a typo/mismatched Compose name
    // before running Docker so existing project data is never hidden by a new one.
    const failure = await new Promise<SandboxResult | undefined>(resolveCheck => {
      let check;
      try { check = spawn('docker', ['volume', 'inspect', volume], { stdio: 'ignore' }); }
      catch { resolveCheck({ status: 'unavailable', runtime: 'unavailable', logs: ['Docker CLI could not be started', limitsLog], error: 'SANDBOX_WORKER_UNAVAILABLE' }); return; }
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; check.kill('SIGKILL'); }, limits.timeoutMs);
      check.on('error', () => { clearTimeout(timer); resolveCheck({ status: 'unavailable', runtime: 'unavailable', logs: ['Docker volume inspection unavailable', limitsLog], error: 'SANDBOX_WORKER_UNAVAILABLE' }); });
      check.on('close', code => {
        clearTimeout(timer);
        resolveCheck(code === 0 && !timedOut ? undefined : { status: 'failed', runtime: 'docker_worker', logs: ['Configured Docker project volume is unavailable; set APPWEAVE_DOCKER_WORKER_VOLUME to the existing Compose volume name', limitsLog], error: timedOut ? 'SANDBOX_TIMEOUT' : 'SANDBOX_VOLUME_UNAVAILABLE' });
      });
    });
    if (failure) return failure;
  }
  const output = { text: '', bytes: 0, truncated: false };
  return await new Promise<SandboxResult>(resolveResult => {
    let timedOut = false;
    let child;
    try { child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolveResult({ status: 'unavailable', runtime: 'unavailable', logs: ['Docker CLI could not be started', limitsLog], error: 'SANDBOX_WORKER_UNAVAILABLE' }); return; }
    child.stdout.on('data', chunk => boundedAppend(output, chunk, limits.maxOutputBytes));
    child.stderr.on('data', chunk => boundedAppend(output, chunk, limits.maxOutputBytes));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' }).on('error', () => {}); }, limits.timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolveResult({ status: 'unavailable', runtime: 'unavailable', logs: [`Docker worker unavailable: ${error.message}`, limitsLog], error: 'SANDBOX_WORKER_UNAVAILABLE' }); });
    child.on('close', code => {
      clearTimeout(timer);
      const logs = ['docker worker started', ...(output.text ? output.text.trimEnd().split(/\r?\n/) : []), ...(output.truncated ? ['worker output truncated at configured limit'] : []), limitsLog];
      if (timedOut) resolveResult({ status: 'failed', runtime: 'docker_worker', logs, error: 'SANDBOX_TIMEOUT' });
       else if (code === 0) resolveResult({ status: 'ready', runtime: 'docker_worker', logs });
       else {
         const storageFailure = /cannot access path|no such file or directory|volume-subpath/i.test(output.text);
         resolveResult({ status: 'failed', runtime: 'docker_worker', logs, error: storageFailure ? 'PROJECT_STORAGE_UNAVAILABLE' : `SANDBOX_EXIT_${code ?? 'UNKNOWN'}` });
       }
    });
  });
}

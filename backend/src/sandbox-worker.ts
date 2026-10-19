import { spawn } from 'node:child_process';
import { relative, resolve } from 'node:path';

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

  const workspace = resolve(process.env.PROJECT_WORKSPACE_ROOT ?? root.slice(0, root.lastIndexOf('/')));
  const projectPath = resolve(root);
  const projectRelative = relative(workspace, projectPath).replaceAll('\\', '/');
  const outputRelative = relative(projectPath, resolve(out)).replaceAll('\\', '/');
  if (!projectRelative || projectRelative.startsWith('../') || projectRelative === '..' || projectRelative.includes('\0')) {
    return { status: 'failed', runtime: 'docker_worker', logs: ['worker refused an unsafe project path'], error: 'UNSAFE_PROJECT_PATH' };
  }
  const volume = process.env.APPWEAVE_DOCKER_WORKER_VOLUME;
  const image = process.env.APPWEAVE_DOCKER_WORKER_IMAGE ?? 'node:20.15.1-bookworm-slim';
  const mount = volume ? `${volume}:/workspace:rw` : `${workspace}:/workspace:rw`;
  if (!outputRelative || outputRelative.startsWith('../') || outputRelative === '..') return { status: 'failed', runtime: 'docker_worker', logs: ['worker refused an unsafe output path'], error: 'UNSAFE_OUTPUT_PATH' };
  const command = `npm install --ignore-scripts --no-audit --no-fund && npm run build && rm -rf ${outputRelative} && mkdir -p ${outputRelative} && cp -a dist/. ${outputRelative}/`;
  const args = ['run', '--rm', '--init', '--memory', `${limits.memoryMb}m`, '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=128m', '--volume', mount, '--workdir', `/workspace/${projectRelative}`, image, 'sh', '-lc', command];
  const output = { text: '', bytes: 0, truncated: false };
  return await new Promise<SandboxResult>(resolveResult => {
    let timedOut = false;
    let child;
    try { child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolveResult({ status: 'unavailable', runtime: 'unavailable', logs: ['Docker CLI could not be started', limitsLog], error: 'SANDBOX_WORKER_UNAVAILABLE' }); return; }
    child.stdout.on('data', chunk => boundedAppend(output, chunk, limits.maxOutputBytes));
    child.stderr.on('data', chunk => boundedAppend(output, chunk, limits.maxOutputBytes));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limits.timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolveResult({ status: 'unavailable', runtime: 'unavailable', logs: [`Docker worker unavailable: ${error.message}`, limitsLog], error: 'SANDBOX_WORKER_UNAVAILABLE' }); });
    child.on('close', code => {
      clearTimeout(timer);
      const logs = ['docker worker started', ...(output.text ? output.text.trimEnd().split(/\r?\n/) : []), ...(output.truncated ? ['worker output truncated at configured limit'] : []), limitsLog];
      if (timedOut) resolveResult({ status: 'failed', runtime: 'docker_worker', logs, error: 'SANDBOX_TIMEOUT' });
      else if (code === 0) resolveResult({ status: 'ready', runtime: 'docker_worker', logs });
      else resolveResult({ status: 'failed', runtime: 'docker_worker', logs, error: `SANDBOX_EXIT_${code ?? 'UNKNOWN'}` });
    });
  });
}

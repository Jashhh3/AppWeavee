export type SandboxLimits = { timeoutMs: number; memoryMb: number; maxOutputBytes: number };
export type SandboxResult = { status: 'ready' | 'unavailable' | 'failed'; runtime: 'docker_worker' | 'unavailable'; logs: string[]; error?: string };
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { timeoutMs: 30_000, memoryMb: 512, maxOutputBytes: 2 * 1024 * 1024 };

/** Optional worker contract. It never executes generated code in Fastify. */
export function sandboxStatus() { const available = process.env.APPWEAVE_DOCKER_WORKER === 'true'; return { available, runtime: available ? 'docker_worker' as const : 'unavailable' as const, limits: DEFAULT_SANDBOX_LIMITS }; }
export async function runSandboxedViteBuild(_root: string, _out: string, limits = DEFAULT_SANDBOX_LIMITS): Promise<SandboxResult> {
  const status = sandboxStatus();
  if (!status.available) return { status: 'unavailable', runtime: 'unavailable', logs: ['vite worker unavailable; Docker worker is not enabled', `worker limits: timeout=${limits.timeoutMs}ms memory=${limits.memoryMb}MiB output=${limits.maxOutputBytes} bytes`] };
  return { status: 'unavailable', runtime: 'unavailable', logs: ['Docker worker is configured but no worker launcher is installed'], error: 'SANDBOX_WORKER_UNAVAILABLE' };
}

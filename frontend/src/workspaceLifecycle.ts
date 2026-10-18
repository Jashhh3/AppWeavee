export type WorkspaceBuildStatus = 'initializing' | 'building' | 'ready' | 'failed' | 'unavailable';

const terminalStatuses = new Set(['active', 'ready', 'completed', 'complete', 'success', 'succeeded', 'failed', 'error']);

export function classifyBuildStatus(build: any, hasPreviewUrl = false): WorkspaceBuildStatus {
  if (!build) return hasPreviewUrl ? 'initializing' : 'unavailable';
  const status = String(build.status || build.state || '').toLowerCase();
  if (['failed', 'error', 'failure'].includes(status)) return 'failed';
  if (['active', 'ready', 'completed', 'complete', 'success', 'succeeded'].includes(status)) return 'ready';
  if (['queued', 'pending', 'initializing', 'created'].includes(status)) return 'initializing';
  if (['building', 'running', 'in_progress', 'in-progress', 'processing'].includes(status)) return 'building';
  return hasPreviewUrl ? 'ready' : 'unavailable';
}

export function isBuildTerminal(build: any) {
  return terminalStatuses.has(String(build?.status || build?.state || '').toLowerCase());
}

export function latestBuild(builds: any[], environment = 'preview') {
  return builds
    .filter(build => !environment || build.environment === environment)
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
}

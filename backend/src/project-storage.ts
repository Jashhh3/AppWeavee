import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export function projectRoot(workspaceRoot: string, projectId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error('Invalid project ID');
  }
  const root = resolve(workspaceRoot);
  const target = resolve(root, projectId);
  const local = relative(root, target);
  if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Project path is outside the configured storage root');
  return target;
}

export async function ensureProjectStorage(workspaceRoot: string, projectId: string): Promise<string> {
  const root = projectRoot(workspaceRoot, projectId);
  await mkdir(root, { recursive: true });
  const details = await stat(root).catch(() => undefined);
  if (!details?.isDirectory()) throw new Error(`Project storage directory is unavailable: ${projectId}`);
  return root;
}

export async function requireProjectStorage(workspaceRoot: string, projectId: string): Promise<string> {
  const root = projectRoot(workspaceRoot, projectId);
  const details = await stat(root).catch(() => undefined);
  if (!details?.isDirectory()) throw new Error(`Project storage directory is missing: ${projectId}`);
  return root;
}

export const projectStoragePath = (workspaceRoot: string, projectId: string, ...parts: string[]) => join(projectRoot(workspaceRoot, projectId), ...parts);

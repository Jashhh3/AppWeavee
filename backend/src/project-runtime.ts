import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, ApplicationSchema } from './types.js';
import { generateReactViteTemplate } from './project-template.js';
import { runSandboxedViteBuild } from './sandbox-worker.js';
import { validateGeneratedReactSource } from './project-source.js';
import { requireProjectStorage } from './project-storage.js';

export type ArtifactBuild = { status: 'ready'|'failed'; runtime: 'artifact_only'|'docker_worker'|'unavailable'; logs: string[]; artifacts: string[]; error?: string };
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'preview', 'production']);

// Source edits must never overwrite a compiled entrypoint (or the last good build).
export async function syncPreviewEntryPoint(_root: string, _changedPath: string): Promise<void> {}

async function files(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith('.')) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, absolute));
    else if (entry.isFile()) result.push(relative(root, absolute).replaceAll('\\', '/'));
    if (result.length > 500) throw new Error('source exceeds 500 files');
  }
  return result;
}

/** Resolve real paths, including symlinks, within exactly one artifact root. */
export async function artifactFile(root: string, path: string): Promise<string> {
  if (!path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || path.split('/').some(part => part === '..' || part.startsWith('.'))) throw new Error('Invalid artifact path');
  const base = await realpath(root);
  const target = await realpath(resolve(base, path));
  const local = relative(base, target);
  if (local.startsWith('..') || isAbsolute(local) || !(await stat(target)).isFile()) throw new Error('Invalid artifact path');
  return target;
}

/** Require real HTML and every local script/style/image reference to exist. */
export async function validateArtifact(root: string): Promise<string> {
  const html = await readFile(await artifactFile(root, 'index.html'), 'utf8');
  if (!/<(?:html|!doctype|head|body|main|h1|div|script)\b/i.test(html) || html.includes('*** Begin Patch')) throw new Error('Invalid dist/index.html');
  for (const tag of html.matchAll(/<(?:script|link|img|source)\b[^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const reference = attribute[1] ?? attribute[2] ?? attribute[3];
      if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
      const path = decodeURIComponent(reference.split(/[?#]/)[0]).replace(/^\//, '').replace(/^\.\//, '');
      if (!path) continue;
      try { await artifactFile(root, path); }
      catch { throw new Error(`Missing or unsafe artifact reference: ${reference}`); }
    }
  }
  return html;
}

export async function buildProjectArtifacts(project: Project, workspaceRoot: string, environment: 'preview'|'production', version: number, _buildId: string, schema?: ApplicationSchema): Promise<ArtifactBuild> {
  const root = await requireProjectStorage(workspaceRoot, project.id);
  const parent = join(root, environment, `version-${version}`);
  const out = join(parent, 'dist');
  const staging = join(parent, `.staging-${randomUUID()}`);
  const logs = ['source validation started'];
  let runtime: ArtifactBuild['runtime'] = 'unavailable';
  try {
    const source = await files(root);
    // Existing dist-only static projects are not empty generated projects.
    const generatedMarker = join(root, '.appweave-artifact.json');
    const hasGeneratedRoot = await stat(generatedMarker).then(() => true, () => false);
    const existingDist = !hasGeneratedRoot && await stat(join(root, 'dist', 'index.html')).then(() => true, () => false);
    const hasLockfile = await stat(join(root, 'package-lock.json')).then(() => true, () => false);
    // A locked project with a complete dist is already browser-ready. Prefer it
    // over the optional Docker compiler; source-only projects still fail clearly
    // if their configured compiler is unavailable.
    const prebuiltDist = existingDist && hasLockfile ? await validateArtifact(join(root, 'dist')).then(() => true, () => false) : false;
    if (!source.length && !existingDist && schema) source.push(...await generateReactViteTemplate(root, project, schema));
    let bytes = 0;
    for (const path of source) bytes += (await stat(join(root, path))).size;
    if (bytes > 5 * 1024 * 1024) throw new Error('source exceeds 5242880 bytes');
    await mkdir(staging, { recursive: true });
    const hasPackage = await stat(join(root, 'package.json')).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    if (prebuiltDist) {
      runtime = 'artifact_only';
      await cp(join(root, 'dist'), staging, { recursive: true });
      logs.push('using pre-built browser artifact; Docker sandbox not required');
    } else if (hasPackage) {
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (!manifest?.scripts || typeof manifest.scripts.build !== 'string') throw new Error('package.json requires a build script');
      await validateGeneratedReactSource(root);
      const worker = await runSandboxedViteBuild(root, staging);
      runtime = worker.runtime;
      logs.push(...worker.logs);
      if (worker.status !== 'ready') throw new Error(worker.error ?? 'SANDBOX_WORKER_UNAVAILABLE');
    } else {
      runtime = 'artifact_only';
      if (existingDist) await cp(join(root, 'dist'), staging, { recursive: true });
      else {
        if (source.some(path => path.startsWith('public/'))) await cp(join(root, 'public'), staging, { recursive: true });
        for (const path of source.filter(path => !path.startsWith('public/'))) {
          await mkdir(join(staging, path, '..'), { recursive: true });
          await cp(join(root, path), join(staging, path));
        }
      }
      logs.push('static artifact project; no package.json or generated shell');
    }
    await validateArtifact(staging);
    // Validate before promotion so a failed rebuild of the same version is harmless.
    const backup = join(parent, `.previous-${randomUUID()}`);
    const hadOutput = await stat(out).then(() => true, () => false);
    if (hadOutput) await rename(out, backup);
    try { await rename(staging, out); }
    catch (error) { if (hadOutput) await rename(backup, out); throw error; }
    await rm(backup, { recursive: true, force: true });
    const rootDist = join(root, 'dist');
    const rootBackup = join(root, `.previous-dist-${randomUUID()}`);
    const hadRootDist = await stat(rootDist).then(() => true, () => false);
    if (hadRootDist) await rename(rootDist, rootBackup);
    try { await cp(out, rootDist, { recursive: true }); }
    catch (error) { if (hadRootDist) await rename(rootBackup, rootDist); throw error; }
    await rm(rootBackup, { recursive: true, force: true });
    await writeFile(generatedMarker, JSON.stringify({ environment, version, generatedAt: new Date().toISOString() }) + '\n', 'utf8');
    await validateArtifact(rootDist);
    logs.push('validated dist/index.html and local asset references', 'artifact written: dist/index.html');
    return { status: 'ready', runtime, logs, artifacts: ['dist/index.html'] };
  } catch (error) {
    const message = error instanceof SyntaxError ? 'package.json is invalid JSON' : error instanceof Error ? error.message : 'build failed';
    return { status: 'failed', runtime, logs: [...logs, `build failed: ${message}`], artifacts: [], error: message };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

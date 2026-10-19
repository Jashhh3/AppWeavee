import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Project } from './types.js';
import type { ApplicationSchema } from './types.js';
import { generateReactViteTemplate } from './project-template.js';
import { runSandboxedViteBuild } from './sandbox-worker.js';

export type ArtifactBuild = { status: 'ready'|'failed'; runtime: 'artifact_only'|'unavailable'; logs: string[]; artifacts: string[]; error?: string };
const MAX_FILES = 500;
const MAX_BYTES = 5 * 1024 * 1024;
const ignored = new Set(['.git', 'node_modules', 'dist', 'build']);

/** Synchronize an already-built preview entrypoint with its source workspace. */
export async function syncPreviewEntryPoint(root: string, changedPath: string): Promise<void> {
  const normalized = changedPath.replaceAll('\\', '/');
  if (normalized !== 'index.html' && normalized !== 'public/index.html') return;
  const sourceHtml = await readFile(join(root, normalized), 'utf8');
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === 'dist') {
        const artifact = join(absolute, 'index.html');
        try { await stat(artifact); await writeFile(artifact, sourceHtml, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else await visit(absolute);
    }
  }
  await visit(root);
}

async function files(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name) || entry.name.startsWith('.')) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, absolute));
    else if (entry.isFile()) result.push(relative(root, absolute).replaceAll('\\', '/'));
    if (result.length > MAX_FILES) throw new Error(`source exceeds ${MAX_FILES} files`);
  }
  return result;
}

export async function buildProjectArtifacts(project: Project, workspaceRoot: string, environment: 'preview'|'production', version: number, buildId: string, schema?: ApplicationSchema): Promise<ArtifactBuild> {
  const root = join(workspaceRoot, project.id);
  const out = join(root, environment, `version-${version}`, 'dist');
  const logs = ['runtime: artifact_only (no project code is executed)', 'source validation started'];
  try {
    await mkdir(root, { recursive: true });
    const source = await files(root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    const sourceFiles = source.filter(path => !path.startsWith(`${environment}/version-`));
    if (!sourceFiles.length && schema) { const generated = await generateReactViteTemplate(root, project, schema); sourceFiles.push(...generated); logs.push(`generated React/Vite source template (${generated.length} files)`); }
    let total = 0;
    for (const path of sourceFiles) total += (await stat(join(root, path))).size;
    if (total > MAX_BYTES) throw new Error(`source exceeds ${MAX_BYTES} bytes`);
    const packageFile = sourceFiles.find(path => path === 'package.json');
    if (packageFile) {
      const manifest = JSON.parse(await readFile(join(root, packageFile), 'utf8')) as { scripts?: unknown; dependencies?: unknown };
      if (manifest.scripts && typeof manifest.scripts !== 'object') throw new Error('package.json scripts must be an object');
      logs.push('package manifest validated; dependency scripts are not executed');
    }
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    const worker = await runSandboxedViteBuild(root, out);
    logs.push(...worker.logs);
    if (sourceFiles.some(path => path.startsWith('public/'))) await cp(join(root, 'public'), out, { recursive: true });
    for (const asset of sourceFiles.filter(path => path.startsWith('src/') && /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/i.test(path))) {
      const target = join(out, asset.slice('src/'.length));
      await mkdir(join(target, '..'), { recursive: true });
      await cp(join(root, asset), target);
    }
    // Preserve non-code source assets when the optional Vite worker is unavailable.
    for (const path of sourceFiles.filter(path => path.startsWith('src/') && !path.endsWith('.jsx') && !path.endsWith('.tsx'))) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      await mkdir(join(out, parent), { recursive: true });
      await cp(join(root, path), join(out, path));
    }
    const html = sourceFiles.find(path => path === 'index.html' || path === 'public/index.html');
    if (html) await cp(join(root, html), join(out, 'index.html'));
    else {
      const sourceLabel = sourceFiles.length ? `Source files: ${sourceFiles.slice(0, 12).join(', ')}` : 'No source was present; generated minimal React-compatible shell.';
      await writeFile(join(out, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${project.name} · AppWeave</title></head><body><div id="root"><h1>${project.name}</h1><p>${sourceLabel}</p><p>Build ${buildId.slice(0, 8)} · artifact-only preview</p></div></body></html>`, 'utf8');
      logs.push(sourceFiles.length ? 'no static entrypoint found; generated bounded preview shell' : 'generated minimal preview shell');
    }
    logs.push(`validated ${sourceFiles.length} source file(s)`, 'artifact written: dist/index.html');
    return { status: 'ready', runtime: 'artifact_only', logs, artifacts: ['dist/index.html'] };
  } catch (error) {
    const message = error instanceof SyntaxError ? 'package.json is invalid JSON' : error instanceof Error ? error.message : 'build failed';
    return { status: 'failed', runtime: 'unavailable', logs: [...logs, `build failed: ${message}`], artifacts: [], error: message };
  }
}

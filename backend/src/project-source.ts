import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { artifactFile } from './project-runtime.js';

/** Validate data/source only. Never imports or executes generated project code. */
export async function validateGeneratedReactSource(root: string): Promise<void> {
  const manifest = JSON.parse(await readFile(await artifactFile(root, 'package.json'), 'utf8'));
  // Stored schemas can be normalized without migrating existing project sources.
  if (manifest.appweave?.framework !== 'react-vite') return;
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const dependency of ['react', 'react-dom', 'vite', '@vitejs/plugin-react']) {
    if (typeof dependencies[dependency] !== 'string' || !dependencies[dependency]) throw new Error(`Generated React project requires dependency: ${dependency}`);
  }
  if (!/\bvite\s+build\b/.test(manifest.scripts?.build ?? '')) throw new Error('Generated React project requires a Vite build script');
  const config = await readFile(await artifactFile(root, 'vite.config.js'), 'utf8');
  if (!config.includes('@vitejs/plugin-react') || !/plugins\s*:\s*\[\s*react\(/.test(config)) throw new Error('Generated React project requires the React Vite plugin');
  const html = await readFile(await artifactFile(root, 'index.html'), 'utf8');
  if (!/\bid\s*=\s*["']root["']/.test(html)) throw new Error('Generated React project requires a root mount');
  const script = [...html.matchAll(/<script\b[^>]*>/gi)].find(tag => /\btype\s*=\s*["']module["']/.test(tag[0]));
  const entry = script?.[0].match(/\bsrc\s*=\s*["']\/?(src\/main\.(jsx|tsx))["']/);
  if (!entry) throw new Error('Generated React project requires its local React module entrypoint');
  const main = await readFile(await artifactFile(root, entry[1]), 'utf8');
  if (!/\bcreateRoot\s*\(/.test(main) || !/\.render\s*\(/.test(main) || !/getElementById\s*\(\s*["']root["']\s*\)/.test(main) || !main.includes('react-dom/client')) throw new Error('Generated React entrypoint must mount React into root');
  if (entry[2] === 'tsx') {
    for (const dependency of ['typescript', '@types/react', '@types/react-dom']) if (!dependencies[dependency]) throw new Error(`Generated TypeScript project requires dependency: ${dependency}`);
    await artifactFile(root, 'tsconfig.json');
  }
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);
    const content = await readFile(await artifactFile(root, path), 'utf8');
    // Includes side-effect imports, re-exports, dynamic imports, and CSS imports.
    const imports = /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|@import\s+["']([^"']+)["']/g;
    for (const match of content.matchAll(imports)) {
      const reference = match[1] ?? match[2] ?? match[3];
      if (!reference.startsWith('.') && !reference.startsWith('/')) continue;
      const local = reference.split(/[?#]/)[0];
      const target = relative(resolve(root), resolve(local.startsWith('/') ? root : dirname(resolve(root, path)), local.replace(/^\//, ''))).replaceAll('\\', '/');
      const candidates = [target, ...['.js', '.jsx', '.ts', '.tsx', '.css', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'].map(suffix => target + suffix)];
      let resolved: string | undefined;
      for (const candidate of candidates) {
        try { await artifactFile(root, candidate); resolved = candidate; break; } catch { /* Try extension/index resolution. */ }
      }
      if (!resolved) throw new Error(`Missing or unsafe local import: ${path} -> ${reference}`);
      if (/\.(?:[jt]sx?|css)$/.test(resolved)) await visit(resolved);
    }
  }
  await visit(entry[1]);
  await visit('vite.config.js');
}

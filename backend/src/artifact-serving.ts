import { readFile } from 'node:fs/promises';
import { artifactFile, validateArtifact } from './project-runtime.js';

/** Scope both absolute Vite references and relative references on nested routes. */
export function scopeArtifactHtml(html: string, base: string): string {
  const scoped = html.replace(/\b(src|href)(\s*=\s*)(['"])\/(?!\/)/gi, `$1$2$3${base}`).replace(/<base\b[^>]*>/gi, '');
  const tag = `<base href="${base}">`;
  if (/<head\b[^>]*>/i.test(scoped)) return scoped.replace(/<head\b[^>]*>/i, `$&${tag}`);
  return scoped.replace(/^(\s*<!doctype[^>]*>)?/i, `$&${tag}`);
}

const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', jsx: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2' };

export async function readArtifactResponse(root: string, path: string, base: string, spa: boolean): Promise<{ type: string; body: string | Buffer }> {
  const entry = async () => ({ type: 'text/html', body: scopeArtifactHtml(await validateArtifact(root), base) });
  if (!path || path === 'index.html') return entry();
  try {
    const body = await readFile(await artifactFile(root, path));
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    return { type: types[extension] ?? 'application/octet-stream', body: extension === 'html' ? scopeArtifactHtml(body.toString('utf8'), base) : body };
  } catch (error) {
    // Only absent, safe extensionless routes may use the SPA entrypoint. Never
    // disguise missing assets, traversal attempts, or symlink escapes as HTML.
    const route = !/[.\\\0]/.test(path) && !path.startsWith('/') && path.split('/').filter(Boolean).every(part => /^[\p{L}\p{N}_~-]+$/u.test(part));
    if (spa && route && (error as NodeJS.ErrnoException).code === 'ENOENT') return entry();
    throw error;
  }
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplicationSchema, Project } from './types.js';

/** Data-only template; it is never imported by the API process. */
export async function generateReactViteTemplate(root: string, project: Project, schema: ApplicationSchema): Promise<string[]> {
  const title = project.name.replace(/[<>"']/g, '');
  const payload = JSON.stringify({ project: title, schema }).replace(/</g, '\\u003c');
  const packageName = `appweave-${project.id.slice(0, 8)}`;
  const typescript = schema.frontend?.language === 'typescript' || schema.frontend?.language === 'tsx';
  const extension = typescript ? 'tsx' : 'jsx';
  const resources = new URL(`../templates/react-vite-${typescript ? 'tsx' : 'jsx'}/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', resources), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', resources), 'utf8'));
  manifest.name = lock.name = lock.packages[''].name = packageName;
  const files: Record<string, string> = {
    'package.json': JSON.stringify(manifest, null, 2) + '\n',
    'package-lock.json': JSON.stringify(lock, null, 2) + '\n',
    'index.html': `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · AppWeave</title></head><body><div id="root"></div><script type="module" src="/src/main.${extension}"></script></body></html>\n`,
    'vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ base: './', esbuild: { jsx: 'automatic' }, plugins: [react()] });\n`,
    [`src/main.${extension}`]: `import React, { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App${typescript ? '' : '.jsx'}';\nimport './style.css';\n\nconst root = document.getElementById('root');\nif (!root) throw new Error('Missing root mount');\ncreateRoot(root).render(<StrictMode><App /></StrictMode>);\n`,
    [`src/App.${extension}`]: `import React from 'react';\n\nconst app = ${payload};\n\nexport default function App() {\n  return <main><small>AppWeave generated application</small><h1>{app.project}</h1><p>Generated from validated specification.</p><section>{Object.entries(app.schema.entities || {}).map(([name, entity]) => <article key={name}><strong>{name}</strong><span>{Object.keys(entity.fields || {}).length} fields</span></article>)}</section></main>;\n}\n`,
    'src/style.css': `:root{font-family:system-ui,sans-serif;color:#18324a;background:#f8f5ee}body{margin:0}main{max-width:760px;margin:10vh auto;padding:48px;background:#fffdf8;border:1px solid #e8dcc9;border-radius:24px}small{color:#a87532;text-transform:uppercase;letter-spacing:.12em}h1{font:700 42px Georgia,serif}section{display:grid;gap:12px}article{display:flex;justify-content:space-between;padding:16px;border:1px solid #e8dcc9;border-radius:12px}\n`,
    '.env.example': '# Add public Vite variables here (prefix with VITE_).\n',
    '.nvmrc': '20.15.1\n',
    'README.md': `# ${title}\n\nGenerated React/Vite application. Requires Node.js 20.15.1.\n\n## Development\n\nRun npm ci and then npm run dev. Copy .env.example to .env.local for public VITE_ variables.\n\n## Build and deploy\n\nRun npm run build, then serve the dist directory with a static host. Run npm run preview to inspect the production build locally.\n`,
  };
  if (typescript) {
    files['tsconfig.json'] = JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, types: ['vite/client'] }, include: ['src'] }, null, 2) + '\n';
    files['src/App.tsx'] = files['src/App.tsx'].replace('const app =', 'const app: { project: string; schema: { entities: Record<string, { fields: Record<string, unknown>; [key: string]: unknown }>; [key: string]: unknown } } =');
  }
  await mkdir(join(root, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content, 'utf8');
  return Object.keys(files);
}

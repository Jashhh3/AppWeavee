import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplicationSchema, Project } from './types.js';

/** Data-only template; it is never imported by the API process. */
export async function generateReactViteTemplate(root: string, project: Project, schema: ApplicationSchema): Promise<string[]> {
  const title = project.name.replace(/[<>"']/g, '');
  const payload = JSON.stringify({ project: title, schema }).replace(/</g, '\\u003c');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: `appweave-${project.id.slice(0, 8)}`, private: true, version: '0.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { '@vitejs/plugin-react': '4.3.1', vite: '5.4.8', react: '18.3.1', 'react-dom': '18.3.1' } }, null, 2) + '\n',
    'package-lock.json': JSON.stringify({ name: `appweave-${project.id.slice(0, 8)}`, version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: `appweave-${project.id.slice(0, 8)}`, version: '0.0.0', dependencies: { '@vitejs/plugin-react': '4.3.1', vite: '5.4.8', react: '18.3.1', 'react-dom': '18.3.1' } } } }, null, 2) + '\n',
    // Keep the generated form usable when the optional Vite worker is unavailable.
    'index.html': `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · AppWeave</title><link rel="stylesheet" href="/src/styles.css"></head><body><main><small>AppWeave generated application</small><h1>${title}</h1><p>Generated from validated specification.</p><form><label>Search records<input type="search" placeholder="Search ${title}"></label><button type="button">Add record</button></form><section>${Object.entries(schema.entities ?? {}).map(([name, entity]) => `<article><strong>${name}</strong><span>${Object.keys(entity.fields ?? {}).length} fields</span></article>`).join('')}</section></main></body></html>\n`,
    'src/main.jsx': `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './styles.css';\nconst app = ${payload};\nfunction App() { return <main><small>AppWeave generated application</small><h1>{app.project}</h1><p>Generated from validated specification.</p><section>{Object.keys(app.schema.entities || {}).map(name => <article key={name}><strong>{name}</strong><span>{Object.keys(app.schema.entities[name]?.fields || {}).length} fields</span></article>)}</section></main>; }\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
    'src/styles.css': `:root{font-family:system-ui,sans-serif;color:#18324a;background:#f8f5ee}body{margin:0}main{max-width:760px;margin:10vh auto;padding:48px;background:#fffdf8;border:1px solid #e8dcc9;border-radius:24px}small{color:#a87532;text-transform:uppercase;letter-spacing:.12em}h1{font:700 42px Georgia,serif}section{display:grid;gap:12px}article{display:flex;justify-content:space-between;padding:16px;border:1px solid #e8dcc9;border-radius:12px}\n`,
  };
  await mkdir(join(root, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content, 'utf8');
  return Object.keys(files);
}

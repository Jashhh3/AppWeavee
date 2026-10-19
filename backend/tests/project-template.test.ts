import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateReactViteTemplate } from '../src/project-template.js';
import type { Project } from '../src/types.js';
import { validateGeneratedReactSource } from '../src/project-source.js';

describe('generated React/Vite project template', () => {
  it.each(['jsx', 'typescript', 'tsx'])('writes a complete, locally resolvable %s project', async language => {
    const root = await mkdtemp(join(tmpdir(), 'appweave-template-'));
    const project = { id: '12345678-project', name: 'Inventory', ownerId: 'owner', environment: 'development', publicClientId: 'client', previewUrl: '', productionUrl: '', createdAt: '', updatedAt: '' } as Project;
    try {
      const extension = language === 'jsx' ? 'jsx' : 'tsx';
      const files = await generateReactViteTemplate(root, project, { entities: { Product: { fields: { name: 'string' } } }, relationships: [], roles: ['admin'], permissions: {}, api: {}, frontend: { framework: 'react-vite', language }, pages: [], features: [] });
       expect(files).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'index.html', 'vite.config.js', `src/main.${extension}`, `src/App.${extension}`, 'src/style.css', '.env.example', 'README.md']));
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      expect(manifest.dependencies).toMatchObject({ react: '18.3.1', 'react-dom': '18.3.1' });
      expect(manifest.devDependencies).toMatchObject({ vite: '5.4.8', '@vitejs/plugin-react': '4.3.1' });
      expect(await readFile(join(root, 'index.html'), 'utf8')).toContain(`src="/src/main.${extension}"`);
       expect(await readFile(join(root, `src/main.${extension}`), 'utf8')).toContain("import './style.css'");
      if (extension === 'tsx') {
        expect(files).toContain('tsconfig.json');
        expect(manifest.devDependencies).toMatchObject({ typescript: '5.5.4', '@types/react': '18.3.12', '@types/react-dom': '18.3.1' });
        expect(files).not.toContain('src/main.jsx');
      }
      const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
      expect(lock.packages[''].name).toBe(manifest.name);
      expect(lock.packages[''].dependencies).toEqual(manifest.dependencies);
      expect(lock.packages[''].devDependencies).toEqual(manifest.devDependencies);
      for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
        expect(lock.packages[`node_modules/${name}`]).toMatchObject({ version, integrity: expect.any(String), resolved: expect.any(String) });
      }
      expect(lock.packages['node_modules/@babel/core']).toBeDefined();
      expect(lock.packages['node_modules/rollup']).toBeDefined();
      await expect(validateGeneratedReactSource(root)).resolves.toBeUndefined();
      const originalManifest = await readFile(join(root, 'package.json'), 'utf8');
      const invalidManifest = JSON.parse(originalManifest);
      delete invalidManifest.dependencies.react;
      await writeFile(join(root, 'package.json'), JSON.stringify(invalidManifest));
      await expect(validateGeneratedReactSource(root)).rejects.toThrow('requires dependency: react');
      invalidManifest.dependencies.react = '18.3.1';
      invalidManifest.scripts.build = 'echo skipped';
      await writeFile(join(root, 'package.json'), JSON.stringify(invalidManifest));
      await expect(validateGeneratedReactSource(root)).rejects.toThrow('Vite build script');
      await writeFile(join(root, 'package.json'), originalManifest);
      const config = await readFile(join(root, 'vite.config.js'), 'utf8');
      await writeFile(join(root, 'vite.config.js'), 'export default {};');
      await expect(validateGeneratedReactSource(root)).rejects.toThrow('React Vite plugin');
      await writeFile(join(root, 'vite.config.js'), config);
      const main = await readFile(join(root, `src/main.${extension}`), 'utf8');
      await writeFile(join(root, `src/main.${extension}`), main.replace('createRoot(root)', 'notReact(root)'));
      await expect(validateGeneratedReactSource(root)).rejects.toThrow('mount React');
      await writeFile(join(root, `src/main.${extension}`), main);
      await writeFile(join(root, `src/helper.${extension}`), 'export const label = "Valid local module";\n');
      await writeFile(join(root, `src/App.${extension}`), 'import {\n  label\n} from "./helper";\nexport default function App() { return <div>{label}</div>; }\n');
      await expect(validateGeneratedReactSource(root)).resolves.toBeUndefined();
      await writeFile(join(root, `src/App.${extension}`), "import './missing-module';\nexport default function App() { return null; }\n");
      await expect(validateGeneratedReactSource(root)).rejects.toThrow('Missing or unsafe local import');
      await writeFile(join(root, `src/App.${extension}`), 'export default function App() { return null; }\n');
      await writeFile(join(root, 'index.html'), `<script type="module" src="/src/main.${extension}"></script>`);
      await expect(validateGeneratedReactSource(root)).rejects.toThrow('root mount');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not impose the generated contract on legacy static projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'appweave-legacy-'));
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'custom-build' } }));
      await expect(validateGeneratedReactSource(root)).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

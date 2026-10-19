// Trusted template smoke only. Production generated-code builds must use Docker.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { generateReactViteTemplate } from '../dist/src/project-template.js';
import { normalizeApplicationSpec } from '../dist/src/application-spec.js';
import { validateArtifact } from '../dist/src/project-runtime.js';

const root = await mkdtemp(join(tmpdir(), 'appweave-react-smoke-'));
// Representative provider spec for "Create a task dashboard" (no React wording).
// This is not a live provider request or evidence of Docker execution.
const { schema } = normalizeApplicationSpec({ schema: { entities: { Task: { fields: { title: 'string', completed: 'boolean' } } } } });
await generateReactViteTemplate(root, { id: 'smoke-test', name: 'Task dashboard' }, schema);
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn('npm', args, { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm exited ${code}`)));
});
await run(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
await run(['run', 'build']);
await validateArtifact(join(root, 'dist'));
const html = await readFile(join(root, 'dist/index.html'), 'utf8');
if (html.includes('/src/main.jsx') || !html.includes('assets/')) throw new Error('Uncompiled preview');
console.log('Trusted template compiled and artifact references validated.');
if (process.argv.includes('--serve')) {
  const child = spawn('npm', ['run', 'preview', '--', '--host', '0.0.0.0', '--port', '4199', '--strictPort'], { cwd: root, stdio: 'inherit' });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', code => process.exit(code ?? 1));
}

import { cp } from 'node:fs/promises';

await cp(new URL('../templates/', import.meta.url), new URL('../dist/templates/', import.meta.url), { recursive: true });

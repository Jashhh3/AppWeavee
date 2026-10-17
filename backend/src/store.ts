import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DB } from './types.js';

const empty = (): DB => ({ users: [], projects: [], projectSettings: [], providerConfigs: [], products: [], audits: [], specs: [], deployments: [], snapshots: [] });
export class Store {
  private db: DB = empty();
  constructor(private readonly file: string) {}
  async load() { try { this.db = { ...empty(), ...JSON.parse(await readFile(this.file, 'utf8')) }; } catch { await this.save(); } return this; }
  private async save() { await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(this.db, null, 2)); }
  get data() { return this.db; }
  async commit<T>(fn: (db: DB) => T): Promise<T> { const result = fn(this.db); await this.save(); return result; }
  id() { return randomUUID(); }
}

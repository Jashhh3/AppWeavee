import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DB } from './types.js';

const empty = (): DB => ({ users: [], projects: [], projectSettings: [], providerConfigs: [], products: [], audits: [], specs: [], deployments: [], snapshots: [], projectMemory: [], decisions: [], buildHistory: [], graphNodes: [], graphEdges: [] });
export class Store {
  private db: DB = empty();
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async load() {
    try { this.db = { ...empty(), ...JSON.parse(await readFile(this.file, 'utf8')) }; }
    catch (error) {
      try { await mkdir(dirname(this.file), { recursive: true }); await rename(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* first boot or an unavailable old file */ }
      this.db = empty(); await this.save();
    }
    return this;
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = join(dirname(this.file), `.${this.file.split(/[\\/]/).pop()}.tmp-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(this.db, null, 2), 'utf8');
    await rename(temporary, this.file);
  }
  get data() { return this.db; }
  async commit<T>(fn: (db: DB) => T): Promise<T> {
    let result!: T;
    const operation = this.writeQueue.then(async () => { result = fn(this.db); await this.save(); });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }
  async flush() { await this.writeQueue; }
  id() { return randomUUID(); }
}

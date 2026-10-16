import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);
export type VersionFiles = Record<string, string>;
/** Repositories contain generated project state only; backend source is never placed in them. */
export class ProjectVersionRepo {
  private git: boolean | undefined;
  constructor(private readonly root: string, private readonly projectId: string) {}
  private get dir() { return join(this.root, this.projectId); }
  private async run(args: string[]) { return exec("git", args, { cwd: this.dir, maxBuffer: 2_000_000 }); }
  async init() {
    await mkdir(this.dir, { recursive: true });
    if (this.git === undefined) { try { await exec("git", ["--version"]); this.git = true; } catch { this.git = false; } }
    if (!this.git) return;
    try { await access(join(this.dir, ".git")); } catch { await this.run(["init", "-q", "-b", "main"]); await this.run(["config", "user.email", "appweave@localhost"]); await this.run(["config", "user.name", "AppWeave"]); }
  }
  async commit(files: VersionFiles, message: string) {
    await this.init();
    await Promise.all(Object.entries(files).map(async ([name, content]) => { const path = join(this.dir, name); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, content); }));
    if (!this.git) return undefined;
    await this.run(["add", "--all"]); await this.run(["commit", "-q", "--allow-empty", "-m", message]); return (await this.run(["rev-parse", "HEAD"])).stdout.trim();
  }
  async changedFiles(left: VersionFiles, right: VersionFiles) { const names = new Set([...Object.keys(left), ...Object.keys(right)]); return [...names].sort().filter(name => left[name] !== right[name]).map(name => ({ path: name, status: left[name] === undefined ? "added" : right[name] === undefined ? "deleted" : "modified" })); }
}

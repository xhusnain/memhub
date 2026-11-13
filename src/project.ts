import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export function projectKey(cwd: string | undefined | null, home: string = homedir()): string | null {
  if (!cwd) return null;
  const start = resolve(cwd);
  const stop = resolve(home);
  let dir = start;
  for (;;) {
    if (dir === stop || dirname(dir) === dir) break;
    if (existsSync(join(dir, ".git"))) return normalize(basename(dir));
    dir = dirname(dir);
  }
  if (start === stop || dirname(start) === start) return null;
  return normalize(basename(start));
}

function normalize(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, "-");
  return key || null;
}

export function projectScope(project: string | null | undefined): string | null {
  return project ? `project:${project}` : null;
}

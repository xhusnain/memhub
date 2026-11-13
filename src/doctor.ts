import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Pool } from "pg";
import { loadConfig, type Config } from "./config.js";
import { clientByKey } from "./clients.js";
import { openPool, portOpen, startLocalDb, stopLocalDb } from "./localdb.js";
import { pendingSessions, queueDir } from "./reflect.js";
import { redactErr } from "./redact.js";
import { resolveMemhubCommand } from "./wizard/init.js";

const RECENT_ERROR_DAYS = 7;

export type Check = { ok: boolean; label: string; fix?: string };

export type DoctorDeps = {
  baseDir: string;
  home: string;
  connect: (url: string) => Promise<Pool>;
  onPath: (bin: string) => boolean;
  command: () => string | null;
};

function lastHookError(baseDir: string): string | null {
  const path = join(baseDir, "hooks.log");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const last = lines[lines.length - 1];
  const at = Date.parse(last.slice(0, 24));
  if (!Number.isFinite(at) || Date.now() - at > RECENT_ERROR_DAYS * 86400000) return null;
  return last;
}

export async function runChecks(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  let cfg: Config;
  try {
    cfg = loadConfig(deps.baseDir);
  } catch (e) {
    return [{ ok: false, label: redactErr(e), fix: "npx memhub init" }];
  }
  checks.push({ ok: true, label: `Config found — namespace "${cfg.namespace}", ${cfg.captureMode} capture, ${cfg.localDb ? "local database" : "your own Postgres"}` });

  const bin = deps.command();
  checks.push(bin
    ? { ok: true, label: `memhub command is installed at ${bin}` }
    : { ok: false, label: "memhub command is not installed, so AI CLIs cannot start it", fix: "npm install -g memhub, then memhub init (choose Keep & re-apply)" });

  try {
    const pool = await deps.connect(cfg.postgresUrl);
    try {
      const { rows } = await pool.query(
        "select count(*) filter (where status='active')::int as active, count(*)::int as total from memories where namespace=$1",
        [cfg.namespace]
      );
      checks.push({ ok: true, label: `Database reachable — ${rows[0].active} active memories (${rows[0].total} stored in total)` });
    } finally {
      await pool.end().catch(() => {});
    }
  } catch (e) {
    checks.push({
      ok: false, label: `Database not reachable: ${redactErr(e)}`,
      fix: cfg.localDb ? "memhub db start" : "check the connection string with: memhub init",
    });
  }

  for (const key of cfg.clients) {
    const adapter = clientByKey(key);
    if (!adapter) continue;
    const registered = adapter.registeredCommand?.(deps.home);
    if (registered !== undefined && registered !== null && !registered.startsWith("/")) {
      checks.push(deps.onPath(registered)
        ? { ok: true, label: `${adapter.title}: starts memhub as "${registered}"` }
        : { ok: false, label: `${adapter.title}: registered to start "${registered}", which is not on PATH`, fix: "memhub init (choose Keep & re-apply)" });
    }
    if (cfg.captureMode === "auto" && adapter.hooksInstalled) {
      checks.push(adapter.hooksInstalled(deps.home)
        ? { ok: true, label: `${adapter.title}: memory hooks installed` }
        : { ok: false, label: `${adapter.title}: memory hooks are missing`, fix: "memhub init (choose Keep & re-apply)" });
    }
    const instructions = adapter.instructionsFile(deps.home);
    if (cfg.captureMode === "auto" && instructions) {
      const present = existsSync(instructions) && readFileSync(instructions, "utf8").includes("memhub:auto-capture START");
      checks.push(present
        ? { ok: true, label: `${adapter.title}: instructions present` }
        : { ok: false, label: `${adapter.title}: instructions block is missing from ${instructions}`, fix: "memhub init (choose Keep & re-apply)" });
    }
  }

  if (cfg.captureMode === "auto") {
    const runner = cfg.dreamCommand?.[0] ?? "claude";
    checks.push(deps.onPath(runner)
      ? { ok: true, label: `Background learning can run (${runner} found)` }
      : { ok: false, label: `Background learning cannot run: ${runner} is not on PATH`, fix: "install Claude Code, or set dreamCommand in ~/.memhub/config.json" });
  }

  const waiting = pendingSessions(queueDir(deps.baseDir)).length;
  checks.push({ ok: true, label: `${waiting} session(s) waiting to be learned from` });
  const err = lastHookError(deps.baseDir);
  if (err) checks.push({ ok: false, label: `A hook failed recently: ${err}`, fix: "fix the cause above, then run memhub doctor again" });
  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label}${c.ok || !c.fix ? "" : `\n    → ${c.fix}`}`).join("\n");
}

function onPath(bin: string): boolean {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; }
}

export async function runDoctor(): Promise<void> {
  const checks = await runChecks({
    baseDir: join(homedir(), ".memhub"),
    home: homedir(),
    connect: (url) => openPool(url, { connectionTimeoutMillis: 5000 }),
    onPath,
    command: resolveMemhubCommand,
  });
  console.log(formatChecks(checks));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} problem(s) found.` : "\nEverything is set up.");
  process.exitCode = failed ? 1 : 0;
}

export async function runDb(action: string | undefined): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.localDb) {
    console.log("This setup uses your own Postgres, so there is no local database to manage.");
    return;
  }
  if (action === "start") {
    await startLocalDb(cfg.localDb);
    console.log(`Local database running on port ${cfg.localDb.port}.`);
  } else if (action === "stop") {
    if (await portOpen(cfg.localDb.port)) stopLocalDb(cfg.localDb);
    console.log("Local database stopped. It starts again by itself the next time memhub needs it.");
  } else if (action === "status") {
    const up = await portOpen(cfg.localDb.port);
    console.log(`Local database is ${up ? "running" : "stopped"} (port ${cfg.localDb.port}, data in ${cfg.localDb.dataDir}).`);
  } else {
    console.log("Usage: memhub db <start|stop|status>");
    process.exitCode = 1;
  }
}

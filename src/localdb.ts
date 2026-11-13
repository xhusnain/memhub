import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { Pool, type PoolConfig } from "pg";
import { loadConfig, type Config } from "./config.js";

export const LOCAL_PG_VERSION = "18.6.0-beta.19";
const DEFAULT_PORT = 54329;
const PORT_TRIES = 20;
const START_TIMEOUT_MS = 15000;
const PROBE_MS = 300;

export type LocalDb = { port: number; dataDir: string; binDir: string };
export type LocalSetup = { postgresUrl: string; localDb: LocalDb };

const PLATFORMS: Record<string, string> = {
  "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
};

export function platformPackage(platform = process.platform, arch = process.arch): string | null {
  const key = PLATFORMS[`${platform}-${arch}`];
  return key ? `@embedded-postgres/${key}` : null;
}

export function localSupported(): boolean {
  return platformPackage() !== null;
}

function hydrateSymlinks(pkgRoot: string): void {
  let links: { source: string; target: string }[] = [];
  try { links = JSON.parse(readFileSync(join(pkgRoot, "native", "pg-symlinks.json"), "utf8")); } catch {}
  for (const { source, target } of links) {
    const targetPath = resolve(pkgRoot, target);
    try { symlinkSync(relative(dirname(targetPath), resolve(pkgRoot, source)), targetPath); } catch {}
  }
}

export function installLocalPostgres(baseDir: string): string {
  const pkg = platformPackage();
  if (!pkg) throw new Error(`No built-in Postgres for ${process.platform}-${process.arch} — use a Postgres URL instead.`);
  const prefix = join(baseDir, "pg");
  const pkgRoot = join(prefix, "node_modules", ...pkg.split("/"));
  const binDir = join(pkgRoot, "native", "bin");
  if (!existsSync(join(binDir, "pg_ctl"))) {
    mkdirSync(prefix, { recursive: true });
    execFileSync("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--no-save", `${pkg}@${LOCAL_PG_VERSION}`], { stdio: "ignore" });
  }
  hydrateSymlinks(pkgRoot);
  if (!existsSync(join(binDir, "pg_ctl"))) throw new Error("Postgres download did not produce the expected binaries.");
  return binDir;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const srv = createServer();
    srv.once("error", () => done(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => done(true)));
  });
}

export function portOpen(port: number, ms = PROBE_MS): Promise<boolean> {
  return new Promise((done) => {
    const sock = netConnect({ port, host: "127.0.0.1" });
    const finish = (ok: boolean) => { sock.destroy(); done(ok); };
    sock.setTimeout(ms, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

async function pickPort(): Promise<number> {
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_TRIES; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`No free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_TRIES - 1} for the local database.`);
}

function urlFor(port: number, password: string): string {
  return `postgres://memhub:${password}@127.0.0.1:${port}/postgres`;
}

export async function initLocalDb(baseDir: string, binDir: string): Promise<LocalSetup> {
  const dataDir = join(baseDir, "pgdata");
  const secretFile = join(baseDir, "pgdata.secret");
  if (existsSync(join(dataDir, "PG_VERSION")) && existsSync(secretFile)) {
    const saved = JSON.parse(readFileSync(secretFile, "utf8")) as { port: number; password: string };
    return { postgresUrl: urlFor(saved.port, saved.password), localDb: { port: saved.port, dataDir, binDir } };
  }
  if (existsSync(dataDir)) throw new Error(`${dataDir} exists but was not created by memhub init — move it away and retry.`);
  const port = await pickPort();
  const password = randomBytes(18).toString("hex");
  const pwFile = join(baseDir, `pw.${process.pid}.tmp`);
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(pwFile, password + "\n", { mode: 0o600 });
  try {
    execFileSync(join(binDir, "initdb"),
      ["-D", dataDir, "-U", "memhub", `--pwfile=${pwFile}`, "-A", "scram-sha-256", "-E", "UTF8", "--locale=C"],
      { stdio: "ignore" });
  } finally {
    rmSync(pwFile, { force: true });
  }
  appendFileSync(join(dataDir, "postgresql.conf"),
    `\nport = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n`);
  writeFileSync(secretFile, JSON.stringify({ port, password }), { mode: 0o600 });
  return { postgresUrl: urlFor(port, password), localDb: { port, dataDir, binDir } };
}

function pgCtl(db: LocalDb, args: string[]): void {
  execFileSync(join(db.binDir, "pg_ctl"), ["-D", db.dataDir, ...args], { stdio: "ignore" });
}

export async function startLocalDb(db: LocalDb, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  if (await portOpen(db.port)) return;
  try { pgCtl(db, ["-l", join(dirname(db.dataDir), "postgres.log"), "-w", "-t", "15", "start"]); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(db.port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The local memhub database did not start — see ${join(dirname(db.dataDir), "postgres.log")}.`);
}

export function stopLocalDb(db: LocalDb): void {
  pgCtl(db, ["-m", "fast", "-w", "stop"]);
}

export async function setupLocalDb(baseDir: string): Promise<LocalSetup> {
  const binDir = installLocalPostgres(baseDir);
  const setup = await initLocalDb(baseDir, binDir);
  await startLocalDb(setup.localDb);
  return setup;
}

export async function ensureLocalDb(cfg: Pick<Config, "localDb">): Promise<void> {
  if (cfg.localDb) await startLocalDb(cfg.localDb);
}

export async function openPool(url: string, extra: PoolConfig = {}, baseDir = join(homedir(), ".memhub")): Promise<Pool> {
  try {
    const cfg = loadConfig(baseDir);
    if (cfg.localDb && cfg.postgresUrl === url) await startLocalDb(cfg.localDb);
  } catch {}
  return new Pool({ connectionString: url, ...extra });
}

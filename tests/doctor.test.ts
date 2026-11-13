import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/store.js";
import { saveConfig } from "../src/config.js";
import { clientByKey } from "../src/clients.js";
import { applyCaptureSnippet } from "../src/wizard/capture-snippet.js";
import { enqueueSession, queueDir } from "../src/reflect.js";
import { runChecks, formatChecks, type DoctorDeps } from "../src/doctor.js";
import { platformPackage } from "../src/localdb.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });

function setup(over: Partial<DoctorDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "doc-"));
  const baseDir = join(root, "cfg");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const deps: DoctorDeps = {
    baseDir, home,
    connect: async (url) => new Pool({ connectionString: url, connectionTimeoutMillis: 1500 }),
    onPath: () => true,
    command: () => "/usr/local/bin/memhub",
    ...over,
  };
  return { deps, baseDir, home };
}

describe("memhub doctor", () => {
  it("points to init when there is no config", async () => {
    const { deps } = setup();
    const checks = await runChecks(deps);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ ok: false, fix: "npx memhub init" });
  });

  it("passes on a complete setup and reports the memory count", async () => {
    const { deps, baseDir, home } = setup();
    saveConfig({ postgresUrl: container.getConnectionUri(), namespace: "doc", captureMode: "auto", embeddings: { provider: "none" }, clients: ["claude", "gemini"] }, baseDir);
    await new MemoryStore(pool, "doc").remember({ content: "Always use pnpm" });
    clientByKey("claude")!.installHooks!(home);
    applyCaptureSnippet(clientByKey("claude")!.instructionsFile(home)!, "auto");
    applyCaptureSnippet(clientByKey("gemini")!.instructionsFile(home)!, "auto");
    const checks = await runChecks(deps);
    expect(checks.every((c) => c.ok)).toBe(true);
    const text = formatChecks(checks);
    expect(text).toMatch(/Database reachable — 1 active memories/);
    expect(text).toMatch(/Claude Code: memory hooks installed/);
    expect(text).toMatch(/Gemini CLI: instructions present/);
    expect(text).toMatch(/0 session\(s\) waiting/);
  });

  it("names each problem with the command that fixes it", async () => {
    const { deps, baseDir } = setup({ onPath: () => false, command: () => null });
    saveConfig({ postgresUrl: "postgres://nobody:x@127.0.0.1:1/none", namespace: "doc", captureMode: "auto", embeddings: { provider: "none" }, clients: ["claude"] }, baseDir);
    enqueueSession({ sessionId: "s1", transcriptPath: "/tmp/none.jsonl" }, queueDir(baseDir));
    writeFileSync(join(baseDir, "hooks.log"), `${new Date().toISOString()} prompt: timed out after 8000ms\n`);
    const text = formatChecks(await runChecks(deps));
    expect(text).toMatch(/✗ memhub command is not installed[^\n]*\n    → npm install -g memhub/);
    expect(text).toMatch(/✗ Database not reachable[^\n]*\n    → check the connection string/);
    expect(text).not.toMatch(/nobody:x@/);
    expect(text).toMatch(/✗ Claude Code: memory hooks are missing[^\n]*\n    → memhub init/);
    expect(text).toMatch(/✗ Claude Code: instructions block is missing/);
    expect(text).toMatch(/✗ Background learning cannot run: claude is not on PATH/);
    expect(text).toMatch(/✓ 1 session\(s\) waiting/);
    expect(text).toMatch(/✗ A hook failed recently: [^\n]*timed out/);
  });

  it("accepts a memhub that is installed off PATH and says where", async () => {
    const { deps, baseDir, home } = setup({ command: () => "/opt/node/bin/memhub" });
    saveConfig({ postgresUrl: container.getConnectionUri(), namespace: "doc", captureMode: "auto", embeddings: { provider: "none" }, clients: ["claude"] }, baseDir);
    clientByKey("claude")!.installHooks!(home, "/opt/node/bin/memhub");
    applyCaptureSnippet(clientByKey("claude")!.instructionsFile(home)!, "auto");
    const checks = await runChecks(deps);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(formatChecks(checks)).toMatch(/installed at \/opt\/node\/bin\/memhub/);
  });

  it("catches hooks registered with a bare command that is not on PATH", async () => {
    const { deps, baseDir, home } = setup({ onPath: (bin) => bin !== "memhub" });
    saveConfig({ postgresUrl: container.getConnectionUri(), namespace: "doc", captureMode: "auto", embeddings: { provider: "none" }, clients: ["claude"] }, baseDir);
    clientByKey("claude")!.installHooks!(home);
    applyCaptureSnippet(clientByKey("claude")!.instructionsFile(home)!, "auto");
    const text = formatChecks(await runChecks(deps));
    expect(text).toMatch(/✗ Claude Code: registered to start "memhub", which is not on PATH\n    → memhub init/);
  });

  it("does not ask for hooks or a runner in manual mode, and ignores old hook errors", async () => {
    const { deps, baseDir } = setup({ onPath: () => false });
    saveConfig({ postgresUrl: container.getConnectionUri(), namespace: "doc", captureMode: "manual", embeddings: { provider: "none" }, clients: ["claude"] }, baseDir);
    writeFileSync(join(baseDir, "hooks.log"), `2020-01-01T00:00:00.000Z prompt: old failure\n`);
    const checks = await runChecks(deps);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(formatChecks(checks)).not.toMatch(/hooks|Background learning|old failure/);
  });

  it("suggests starting the local database when that is what is down", async () => {
    const { deps, baseDir } = setup();
    saveConfig({
      postgresUrl: "postgres://memhub:x@127.0.0.1:1/postgres", namespace: "doc", captureMode: "manual",
      embeddings: { provider: "none" }, clients: [], localDb: { port: 1, dataDir: "/nope/pgdata", binDir: "/nope/bin" },
    }, baseDir);
    expect(formatChecks(await runChecks(deps))).toMatch(/Database not reachable[^\n]*\n    → memhub db start/);
  });
});

describe("local database platforms", () => {
  it("maps supported platforms to their Postgres package and rejects the rest", () => {
    expect(platformPackage("darwin", "arm64")).toBe("@embedded-postgres/darwin-arm64");
    expect(platformPackage("linux", "x64")).toBe("@embedded-postgres/linux-x64");
    expect(platformPackage("win32", "x64")).toBeNull();
    expect(platformPackage("freebsd", "x64")).toBeNull();
  });
});

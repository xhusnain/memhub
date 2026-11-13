import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/store.js";
import { handleHook, type HookDeps } from "../src/hooks.js";
import { pendingSessions, queueDir, enqueueSession } from "../src/reflect.js";
import type { Config } from "../src/config.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });
beforeEach(async () => { await pool.query("delete from memories"); });

function makeDeps(over: { captureMode?: "auto" | "manual"; env?: NodeJS.ProcessEnv } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "mh-"));
  let spawned = 0;
  const cfg: Config = {
    postgresUrl: container.getConnectionUri(), namespace: "hooker",
    captureMode: over.captureMode ?? "auto", embeddings: { provider: "none" }, clients: ["claude"],
  };
  const deps: HookDeps = {
    loadCfg: () => cfg,
    connect: async (url) => new Pool({ connectionString: url }),
    baseDir,
    spawnReflect: () => { spawned++; },
    env: over.env ?? {},
  };
  return { deps, baseDir, spawned: () => spawned };
}

function projectDir(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "proj-")), name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

describe("session-start hook", () => {
  it("injects the peer card and key memories for the current project", async () => {
    const s = new MemoryStore(pool, "hooker");
    await s.remember({ content: "IDENTITY: prefers concise answers", kind: "peer-card" });
    await s.remember({ content: "Always use pnpm", salience: 0.9 });
    await s.remember({ content: "Alpha deploys to Vercel", scope: "project:alpha" });
    await s.remember({ content: "Beta deploys to Fly", scope: "project:beta" });
    const { deps } = makeDeps();
    const out = await handleHook("session-start", { source: "startup", cwd: projectDir("alpha") }, deps);
    expect(out).toMatch(/^\[memhub\]/);
    expect(out).toMatch(/ABOUT THE USER:\nIDENTITY: prefers concise answers/);
    expect(out).toMatch(/• Always use pnpm \(id [0-9a-f]{8}\)/);
    expect(out).toMatch(/Alpha deploys to Vercel/);
    expect(out).not.toMatch(/Beta deploys to Fly/);
    expect(out.length).toBeLessThan(2800);
  });

  it("stays silent with an empty memory and on resume", async () => {
    const { deps } = makeDeps();
    expect(await handleHook("session-start", { source: "startup" }, deps)).toBe("");
    await new MemoryStore(pool, "hooker").remember({ content: "Always use pnpm" });
    expect(await handleHook("session-start", { source: "resume" }, deps)).toBe("");
  });

  it("keeps the injected block inside its budget however many memories exist", async () => {
    const s = new MemoryStore(pool, "hooker");
    for (let i = 0; i < 40; i++) await s.remember({ content: `Standing rule number ${i}: ` + "x".repeat(300), salience: 0.9 });
    const { deps } = makeDeps();
    const out = await handleHook("session-start", { source: "startup" }, deps);
    expect(out.length).toBeLessThan(2800);
    expect(out).toMatch(/KEY MEMORIES/);
  });

  it("starts a reflection sweep when sessions are waiting", async () => {
    const { deps, baseDir, spawned } = makeDeps();
    enqueueSession({ sessionId: "orphan", transcriptPath: "/tmp/none.jsonl" }, queueDir(baseDir));
    await handleHook("session-start", { source: "startup" }, deps);
    expect(spawned()).toBe(1);
  });
});

describe("prompt hook", () => {
  const seed = async () => {
    const s = new MemoryStore(pool, "hooker");
    for (const f of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]) {
      await s.remember({ content: `The ${f} project has its own repository` });
    }
    const { memory: yellow } = await s.remember({ content: "For Remotion videos the user prefers a yellow background" });
    await s.supersede(yellow.id, "For Remotion videos the user prefers a red background", "red looks better");
  };

  it("injects the matching preference with its change history", async () => {
    await seed();
    const { deps } = makeDeps();
    const out = await handleHook("prompt", { prompt: "create a remotion video for the launch" }, deps);
    expect(out).toMatch(/^\[memhub\] Memories that may apply/);
    expect(out).toMatch(/red background \[was: "For Remotion videos the user prefers a yellow background" until/);
    expect(out.split("\n").length).toBeLessThanOrEqual(4);
  });

  it("clips a wordy memory so it cannot starve the others", async () => {
    const s = new MemoryStore(pool, "hooker");
    for (const f of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) {
      await s.remember({ content: `The ${f} project has its own repository` });
    }
    await s.remember({ content: "Remotion videos: " + "very long explanation ".repeat(80) });
    await s.remember({ content: "Remotion videos render at 1080p" });
    const { deps } = makeDeps();
    const out = await handleHook("prompt", { prompt: "render the remotion videos again" }, deps);
    expect(out).toMatch(/render at 1080p/);
    expect(out).toMatch(/very long explanation[^\n]*…/);
    expect(out.length).toBeLessThan(1200);
  });

  it("injects nothing for unrelated, tiny, or slash-command prompts", async () => {
    await seed();
    const { deps } = makeDeps();
    expect(await handleHook("prompt", { prompt: "tidy up the project a little" }, deps)).toBe("");
    expect(await handleHook("prompt", { prompt: "ok thanks" }, deps)).toBe("");
    expect(await handleHook("prompt", { prompt: "/remotion video settings" }, deps)).toBe("");
  });
});

describe("session-end and pre-compact hooks", () => {
  it("queue the transcript locally and start a reflection, without the database", async () => {
    const { deps, baseDir, spawned } = makeDeps();
    deps.connect = async () => { throw new Error("must not connect"); };
    deps.env = { MEMHUB_CLIENT: "claude" };
    const cwd = projectDir("alpha");
    expect(await handleHook("session-end", { session_id: "s-9", transcript_path: "/tmp/s-9.jsonl", cwd }, deps)).toBe("");
    expect(await handleHook("pre-compact", { session_id: "s-9", transcript_path: "/tmp/s-9.jsonl", cwd }, deps)).toBe("");
    const pending = pendingSessions(queueDir(baseDir));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ sessionId: "s-9", project: "alpha", client: "claude", transcriptPath: "/tmp/s-9.jsonl" });
    expect(spawned()).toBe(2);
  });

  it("ignores an event without a session id or transcript", async () => {
    const { deps, baseDir, spawned } = makeDeps();
    await handleHook("session-end", { cwd: "/tmp" }, deps);
    expect(pendingSessions(queueDir(baseDir))).toHaveLength(0);
    expect(spawned()).toBe(0);
  });
});

describe("hook guards", () => {
  it("does nothing inside a dream or reflection run, in manual mode, or without a config", async () => {
    await new MemoryStore(pool, "hooker").remember({ content: "Always use pnpm" });
    const dreaming = makeDeps({ env: { MEMHUB_DREAMING: "1" } });
    expect(await handleHook("session-start", { source: "startup" }, dreaming.deps)).toBe("");
    await handleHook("session-end", { session_id: "x", transcript_path: "/tmp/x" }, dreaming.deps);
    expect(pendingSessions(queueDir(dreaming.baseDir))).toHaveLength(0);

    const manual = makeDeps({ captureMode: "manual" });
    expect(await handleHook("session-start", { source: "startup" }, manual.deps)).toBe("");

    const unconfigured = makeDeps();
    unconfigured.deps.loadCfg = () => { throw new Error("Config not found"); };
    expect(await handleHook("prompt", { prompt: "create a remotion video" }, unconfigured.deps)).toBe("");
    expect(await handleHook("nonsense", {}, makeDeps().deps)).toBe("");
  });
});

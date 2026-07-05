import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool, Client } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/store.js";
import { buildDreamPrompt, runDreamWith, maybeAutoDream, makeRunner } from "../src/dream.js";
import type { Config } from "../src/config.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

const cfgFor = (ns: string): Config => ({
  postgresUrl: container.getConnectionUri(),
  namespace: ns,
  captureMode: "auto",
  embeddings: { provider: "none" },
  clients: ["claude"],
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });

describe("buildDreamPrompt", () => {
  it("instructs deduction, induction, peer-card, provenance, and conservatism", () => {
    const p = buildDreamPrompt();
    expect(p).toMatch(/deduction/i);
    expect(p).toMatch(/induction/i);
    expect(p).toMatch(/peer card/i);
    expect(p).toMatch(/deductive/i);
    expect(p).toMatch(/at least 2 supporting facts/i);
    expect(p).toMatch(/source memory ids|derived from/i);
    expect(p).toMatch(/supersede/i);
    expect(p).toMatch(/conservative|do nothing|do not invent/i);
  });

  it("carries the update guardrails", () => {
    const p = buildDreamPrompt();
    expect(p).toMatch(/MORE information/);
    expect(p).toMatch(/KEEP BOTH/);
    expect(p).toMatch(/meta-facts/i);
    expect(p).toMatch(/absolute dates/i);
    expect(p).toMatch(/8-character short form/i);
  });

  it("appends near-duplicate candidates when provided", () => {
    const p = buildDreamPrompt(["[aaaa1111] fact A  <->  [bbbb2222] fact A restated  (distance 0.05)"]);
    expect(p).toMatch(/CANDIDATE NEAR-DUPLICATES/);
    expect(p).toMatch(/aaaa1111/);
    expect(buildDreamPrompt()).not.toMatch(/CANDIDATE NEAR-DUPLICATES/);
  });
});

describe("makeRunner", () => {
  it("appends the prompt as the final argument of a custom dream command", () => {
    const runner = makeRunner(["node", "-e", "if (process.argv[1] !== 'dream prompt') process.exit(1)"]);
    expect(() => runner("dream prompt")).not.toThrow();
  });
});

describe("maybeAutoDream (fully-auto trigger)", () => {
  it("spawns while due and stops once a dream completes (markDreamed)", async () => {
    const s = new MemoryStore(pool, "auto-dream-a");
    for (let i = 0; i < 5; i++) await s.remember({ content: `auto fact ${i}` });
    let spawned = 0;
    const r1 = await maybeAutoDream(s, { hours: 6, newThreshold: 5, spawn: () => { spawned++; } });
    expect(r1.triggered).toBe(true);
    expect(spawned).toBe(1);
    const r2 = await maybeAutoDream(s, { hours: 6, newThreshold: 5, spawn: () => { spawned++; } });
    expect(r2.triggered).toBe(true);
    expect(spawned).toBe(2);
    await s.markDreamed();
    const r3 = await maybeAutoDream(s, { hours: 6, newThreshold: 5, spawn: () => { spawned++; } });
    expect(r3.triggered).toBe(false);
    expect(spawned).toBe(2);
  });

  it("skips entirely when MEMHUB_DREAMING is set (recursion guard)", async () => {
    const s = new MemoryStore(pool, "auto-dream-b");
    for (let i = 0; i < 5; i++) await s.remember({ content: `auto fact ${i}` });
    process.env.MEMHUB_DREAMING = "1";
    try {
      let spawned = 0;
      const r = await maybeAutoDream(s, { hours: 6, newThreshold: 5, spawn: () => { spawned++; } });
      expect(r.triggered).toBe(false);
      expect(spawned).toBe(0);
    } finally {
      delete process.env.MEMHUB_DREAMING;
    }
  });
});

describe("runDreamWith", () => {
  it("invokes the reasoning pass with the dream prompt and marks completion", async () => {
    const ns = "dreamer";
    await new MemoryStore(pool, ns).remember({ content: "some fact" });
    let claudePrompt: string | null = null;
    const result = await runDreamWith({
      loadCfg: () => cfgFor(ns),
      connect: async (url) => new Pool({ connectionString: url }),
      runClaude: (prompt) => { claudePrompt = prompt; },
    });
    expect(result.skipped).toBe(false);
    expect(claudePrompt).toMatch(/deduction/i);
    const { rows } = await pool.query("select 1 from memhub_meta where key = $1", [`last_dream:${ns}`]);
    expect(rows.length).toBe(1);
  });

  it("does not fail the run when the claude semantic pass throws, and does not mark the dream done", async () => {
    const ns = "dreamer2";
    await new MemoryStore(pool, ns).remember({ content: "dup2" });
    const result = await runDreamWith({
      loadCfg: () => cfgFor(ns),
      connect: async (url) => new Pool({ connectionString: url }),
      runClaude: () => { throw new Error("claude not found"); },
    });
    expect(result.skipped).toBe(false);
    const { rows } = await pool.query("select 1 from memhub_meta where key = $1", [`last_dream:${ns}`]);
    expect(rows).toHaveLength(0);
  });

  it("skips when another process holds the dream lock", async () => {
    const ns = "locked-ns";
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    await holder.query("select pg_advisory_lock(hashtext('memhub:dream'), hashtext($1))", [ns]);
    let ran = 0;
    try {
      const result = await runDreamWith({
        loadCfg: () => cfgFor(ns),
        connect: async (url) => new Pool({ connectionString: url }),
        runClaude: () => { ran++; },
      });
      expect(result.skipped).toBe(true);
      expect(ran).toBe(0);
    } finally {
      await holder.end();
    }
  });
});

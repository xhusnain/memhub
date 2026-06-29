import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/store.js";
import { buildDreamPrompt, runDreamWith, maybeAutoConsolidate, maybeAutoDream } from "../src/dream.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

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
    expect(p).toMatch(/level: "deductive"|level: \\"deductive\\"|deductive/i);
    expect(p).toMatch(/at least 2 supporting facts/i);
    expect(p).toMatch(/source memory ids|derived from/i);
    expect(p).toMatch(/supersede/i);
    expect(p).toMatch(/conservative|do nothing|do not invent/i);
  });
});

it("maybeAutoConsolidate dedupes + marks when due, then skips (time gate)", async () => {
  const s = new MemoryStore(pool, "auto-dreamer");
  await s.remember({ content: "dup" });
  await s.remember({ content: "dup" });
  await s.remember({ content: "uniq" });
  const r1 = await maybeAutoConsolidate(s, { hours: 6, newThreshold: 1 });
  expect(r1.ran).toBe(true);
  expect(r1.deduped).toBe(1);
  const r2 = await maybeAutoConsolidate(s, { hours: 6, newThreshold: 1 });
  expect(r2.ran).toBe(false);
});

describe("maybeAutoDream (fully-auto trigger)", () => {
  it("triggers, marks, and spawns the background dream when due — then skips (cooldown)", async () => {
    const s = new MemoryStore(pool, "auto-dream-a");
    for (let i = 0; i < 5; i++) await s.remember({ content: `auto fact ${i}` });
    let spawned = 0;
    const r1 = await maybeAutoDream(s, { hours: 6, newThreshold: 5, spawn: () => { spawned++; } });
    expect(r1.triggered).toBe(true);
    expect(spawned).toBe(1);
    const r2 = await maybeAutoDream(s, { hours: 6, newThreshold: 5, spawn: () => { spawned++; } });
    expect(r2.triggered).toBe(false);  // markDreamed advanced the cooldown
    expect(spawned).toBe(1);
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
  it("dedupes then invokes the claude maintenance pass", async () => {
    const ns = "dreamer";
    const s = new MemoryStore(pool, ns);
    await s.remember({ content: "dup fact" });
    await s.remember({ content: "dup fact" });

    let claudePrompt: string | null = null;
    const result = await runDreamWith({
      loadCfg: () => ({ postgresUrl: container.getConnectionUri(), namespace: ns, captureMode: "auto", embeddings: { provider: "none" } }),
      connect: async (url) => new Pool({ connectionString: url }),
      runClaude: (prompt) => { claudePrompt = prompt; },
    });

    expect(result.deduped).toBe(1);
    expect(claudePrompt).toMatch(/deduction/i);
  });

  it("runDreamWith records dream completion (markDreamed)", async () => {
    const ns = "dream-marker";
    await new MemoryStore(pool, ns).remember({ content: "x" });
    await runDreamWith({
      loadCfg: () => ({ postgresUrl: container.getConnectionUri(), namespace: ns, captureMode: "auto", embeddings: { provider: "none" } }),
      connect: async (u) => new Pool({ connectionString: u }),
      runClaude: () => {},
    });
    const { rows } = await pool.query("select 1 from memhub_meta where key = $1", [`last_dream:${ns}`]);
    expect(rows.length).toBe(1);
  });

  it("does not fail the run when the claude semantic pass throws", async () => {
    const ns = "dreamer2";
    const s = new MemoryStore(pool, ns);
    await s.remember({ content: "dup2" });
    await s.remember({ content: "dup2" });

    const result = await runDreamWith({
      loadCfg: () => ({ postgresUrl: container.getConnectionUri(), namespace: ns, captureMode: "auto", embeddings: { provider: "none" } }),
      connect: async (url) => new Pool({ connectionString: url }),
      runClaude: () => { throw new Error("claude not found"); },
    });
    expect(result.deduped).toBe(1);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/store.js";
import { migrateEmbeddings } from "../src/db/migrate-embeddings.js";
import type { Embedder } from "../src/embeddings/types.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
  await migrateEmbeddings(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });
beforeEach(async () => { await pool.query("delete from memories"); await pool.query("delete from memhub_meta"); });

describe("MemoryStore", () => {
  it("remembers and recalls by full-text", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "Deploy the frontend to Vercel, not Netlify", kind: "decision" });
    await s.remember({ content: "Coffee preference is oat milk" });
    const hits = await s.recall("vercel deploy");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toMatch(/Vercel/);
  });

  it("scopes by namespace", async () => {
    const a = new MemoryStore(pool, "alice");
    const b = new MemoryStore(pool, "bob");
    await a.remember({ content: "secret alice fact about kestrels" });
    expect(await b.recall("kestrels")).toHaveLength(0);
    expect(await a.recall("kestrels")).toHaveLength(1);
  });

  it("forget archives so it stops surfacing in recall", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "temporary note about badgers" });
    expect(await s.forget(m.id)).toBe(true);
    expect(await s.recall("badgers")).toHaveLength(0);
  });

  it("supersede archives the old and links the new", async () => {
    const s = new MemoryStore(pool, "husnain");
    const old = await s.remember({ content: "Deploy to Netlify" });
    const fresh = await s.supersede(old.id, "Deploy to Vercel");
    expect(fresh.content).toBe("Deploy to Vercel");
    const recalled = await s.recall("deploy");
    expect(recalled.map(r => r.content)).toEqual(["Deploy to Vercel"]);
  });

  it("confirm bumps last_confirmed_at", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "uses pnpm" });
    const before = m.last_confirmed_at;
    await new Promise(r => setTimeout(r, 10));
    expect(await s.confirm(m.id)).toBe(true);
    const [after] = await s.list();
    expect(new Date(after.last_confirmed_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("forget returns false for an unknown id", async () => {
    const s = new MemoryStore(pool, "husnain");
    expect(await s.forget("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("supersede throws and inserts nothing for an unknown id", async () => {
    const s = new MemoryStore(pool, "husnain");
    const before = (await s.list()).length;
    await expect(s.supersede("00000000-0000-0000-0000-000000000000", "ghost")).rejects.toThrow(/no memory/i);
    expect((await s.list()).length).toBe(before); // no orphan row inserted
  });

  it("history walks the supersession chain newest-to-oldest", async () => {
    const s = new MemoryStore(pool, "husnain");
    const v1 = await s.remember({ content: "Deploy to Netlify" });
    const v2 = await s.supersede(v1.id, "Deploy to Vercel");
    const v3 = await s.supersede(v2.id, "Deploy to Vercel via vercel.json");
    const chain = await s.history(v3.id);
    expect(chain.map((m) => m.content)).toEqual([
      "Deploy to Vercel via vercel.json",
      "Deploy to Vercel",
      "Deploy to Netlify",
    ]);
  });

  it("remember stores and returns the level (default explicit)", async () => {
    const s = new MemoryStore(pool, "husnain");
    const a = await s.remember({ content: "user said X" });
    expect(a.level).toBe("explicit");
    const b = await s.remember({ content: "therefore Y", level: "deductive" });
    expect(b.level).toBe("deductive");
    const got = await s.list({});
    expect(got.find((m) => m.content === "therefore Y")!.level).toBe("deductive");
  });

  it("supersede preserves the original level", async () => {
    const s = new MemoryStore(pool, "husnain");
    const d = await s.remember({ content: "deduced thing", level: "deductive" });
    const d2 = await s.supersede(d.id, "deduced thing v2");
    expect(d2.level).toBe("deductive");
  });

  it("list can filter by status to find archived memories", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "note about otters" });
    await s.forget(m.id);
    const archived = await s.list({ status: "archived" });
    expect(archived.map(r => r.content)).toContain("note about otters");
    const active = await s.list({ status: "active" });
    expect(active.map(r => r.content)).not.toContain("note about otters");
  });
});

// deterministic 3-dim embedder: dimensions = presence of [deploy, coffee, database] concepts
const fakeEmbedder: Embedder = {
  provider: "fake", model: "v1", dim: 3,
  async embed(texts) {
    return texts.map((t) => {
      const s = t.toLowerCase();
      return [
        (s.includes("vercel") || s.includes("deploy") || s.includes("ship") || s.includes("host")) ? 1 : 0,
        (s.includes("coffee") || s.includes("espresso") || s.includes("latte")) ? 1 : 0,
        (s.includes("postgres") || s.includes("database") || s.includes("sql")) ? 1 : 0,
      ];
    });
  },
};

describe("MemoryStore living-memory primitives", () => {
  it("confirm refreshes timestamp and raises confidence, capped at 1.0", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "uses pnpm" });
    expect(m.confidence).toBeCloseTo(0.7, 5);
    await s.confirm(m.id);
    const [after] = await s.list();
    expect(after.confidence).toBeCloseTo(0.8, 4);
    for (let i = 0; i < 5; i++) await s.confirm(m.id); // drive past 1.0
    const [capped] = await s.list();
    expect(capped.confidence).toBeLessThanOrEqual(1.0001);
    expect(capped.confidence).toBeGreaterThan(0.99);
  });

  it("stale() returns active memories not confirmed within N days, oldest first", async () => {
    const s = new MemoryStore(pool, "husnain");
    const old = await s.remember({ content: "old fact about kestrels" });
    await s.remember({ content: "fresh fact about otters" });
    await pool.query("update memories set last_confirmed_at = now() - interval '10 days' where id=$1", [old.id]);
    const stale = await s.stale(7);
    expect(stale.map((r) => r.content)).toContain("old fact about kestrels");
    expect(stale.map((r) => r.content)).not.toContain("fresh fact about otters");
  });

  it("stale() excludes archived/superseded memories", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "archived stale thing" });
    await pool.query("update memories set last_confirmed_at = now() - interval '30 days' where id=$1", [m.id]);
    await s.forget(m.id);
    expect((await s.stale(7)).map((r) => r.content)).not.toContain("archived stale thing");
  });
});

describe("MemoryStore hybrid recall (pgvector)", () => {
  it("recalls a semantically related memory with no shared words", async () => {
    const s = new MemoryStore(pool, "husnain", fakeEmbedder);
    await s.remember({ content: "We ship the frontend to Vercel" });
    await s.remember({ content: "Espresso with oat milk in the morning" });

    // "hosting platform for deployment" shares NO words with the Vercel memory,
    // but is semantically close on the deploy dimension.
    const hits = await s.recall("hosting platform for deployment");
    expect(hits[0].content).toMatch(/Vercel/);
  });

  it("recall degrades to full-text when the embedder fails", async () => {
    const throwing: Embedder = { provider: "fake", model: "v1", dim: 3, async embed() { throw new Error("model down"); } };
    const s = new MemoryStore(pool, "husnain", throwing);
    await s.remember({ content: "Deploy the app to Vercel" }); // memory saved despite embed failure (best-effort)
    const hits = await s.recall("vercel");
    expect(hits[0].content).toMatch(/Vercel/);
  });
});

describe("auto-dream gating", () => {
  it("not due on an empty namespace", async () => {
    const s = new MemoryStore(pool, "husnain");
    expect(await s.shouldAutoDream(6, 5)).toBe(false);
  });
  it("due once enough new memories exist and it has never run", async () => {
    const s = new MemoryStore(pool, "husnain");
    for (let i = 0; i < 5; i++) await s.remember({ content: `auto fact ${i}` });
    expect(await s.shouldAutoDream(6, 5)).toBe(true);
  });
  it("not due right after marking a run (time gate)", async () => {
    const s = new MemoryStore(pool, "husnain");
    for (let i = 0; i < 5; i++) await s.remember({ content: `auto fact ${i}` });
    await s.markDreamed();
    await s.remember({ content: "another" });
    expect(await s.shouldAutoDream(6, 1)).toBe(false);
  });
  it("auto-dream threshold counts explicit facts only, not derived ones", async () => {
    const s = new MemoryStore(pool, "husnain");
    for (let i = 0; i < 4; i++) await s.remember({ content: `explicit ${i}` });
    for (let i = 0; i < 4; i++) await s.remember({ content: `derived ${i}`, level: "deductive" });
    // 4 explicit < 5 threshold even though 8 total rows exist
    expect(await s.shouldAutoDream(6, 5)).toBe(false);
    await s.remember({ content: "explicit 5" });
    expect(await s.shouldAutoDream(6, 5)).toBe(true);
  });

  it("due again once the time window passes", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "x" });
    await s.markDreamed();
    await pool.query("update memhub_meta set value = (now() - interval '7 hours')::text where key = $1", ["last_dream:husnain"]);
    await s.remember({ content: "y" });
    await s.remember({ content: "z" });
    expect(await s.shouldAutoDream(6, 1)).toBe(true);
  });
});

describe("MemoryStore.dedupeExact", () => {
  it("archives exact-duplicate active memories, keeping one survivor", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "Deploy to Vercel" });
    await s.remember({ content: "Deploy to Vercel" });
    await s.remember({ content: "Deploy to Vercel" });
    await s.remember({ content: "Uses pnpm" });

    const archived = await s.dedupeExact();
    expect(archived).toBe(2);

    const active = await s.list({ status: "active" });
    const vercel = active.filter((m) => m.content === "Deploy to Vercel");
    expect(vercel).toHaveLength(1);
    expect(active.filter((m) => m.content === "Uses pnpm")).toHaveLength(1);
  });

  it("does not cross namespaces and ignores already-archived rows", async () => {
    const a = new MemoryStore(pool, "alice");
    const b = new MemoryStore(pool, "bob");
    await a.remember({ content: "shared text" });
    await b.remember({ content: "shared text" });
    expect(await a.dedupeExact()).toBe(0); // only one per namespace
    expect((await b.list({ status: "active" }))).toHaveLength(1);
  });
});

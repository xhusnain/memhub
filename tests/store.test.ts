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
    const { memory: m } = await s.remember({ content: "temporary note about badgers" });
    expect(await s.forget(m.id)).toBe(true);
    expect(await s.recall("badgers")).toHaveLength(0);
  });

  it("supersede archives the old and links the new", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: old } = await s.remember({ content: "Deploy to Netlify" });
    const fresh = await s.supersede(old.id, "Deploy to Vercel");
    expect(fresh.content).toBe("Deploy to Vercel");
    const recalled = await s.recall("deploy");
    expect(recalled.map(r => r.content)).toEqual(["Deploy to Vercel"]);
  });

  it("confirm bumps last_confirmed_at", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: m } = await s.remember({ content: "uses pnpm" });
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
    expect((await s.list()).length).toBe(before);
  });

  it("history walks the supersession chain newest-to-oldest", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: v1 } = await s.remember({ content: "Deploy to Netlify" });
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
    const { memory: a } = await s.remember({ content: "user said X" });
    expect(a.level).toBe("explicit");
    const { memory: b } = await s.remember({ content: "therefore Y", level: "deductive" });
    expect(b.level).toBe("deductive");
    const got = await s.list({});
    expect(got.find((m) => m.content === "therefore Y")!.level).toBe("deductive");
  });

  it("supersede preserves the original level", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: d } = await s.remember({ content: "deduced thing", level: "deductive" });
    const d2 = await s.supersede(d.id, "deduced thing v2");
    expect(d2.level).toBe("deductive");
  });

  it("list can filter by status to find archived memories", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: m } = await s.remember({ content: "note about otters" });
    await s.forget(m.id);
    const archived = await s.list({ status: "archived" });
    expect(archived.map(r => r.content)).toContain("note about otters");
    const active = await s.list({ status: "active" });
    expect(active.map(r => r.content)).not.toContain("note about otters");
  });
});

describe("MemoryStore write-time dedupe", () => {
  it("a duplicate remember confirms the existing memory instead of inserting", async () => {
    const s = new MemoryStore(pool, "husnain");
    const first = await s.remember({ content: "Uses pnpm not npm" });
    expect(first.deduped).toBe(false);
    await new Promise(r => setTimeout(r, 10));
    const second = await s.remember({ content: "Uses pnpm not npm" });
    expect(second.deduped).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(new Date(second.memory.last_confirmed_at).getTime())
      .toBeGreaterThan(new Date(first.memory.last_confirmed_at).getTime());
    expect(second.memory.confidence).toBeGreaterThan(first.memory.confidence);
    expect(await s.list({ status: "active" })).toHaveLength(1);
  });

  it("normalizes whitespace and case before hashing", async () => {
    const s = new MemoryStore(pool, "husnain");
    const first = await s.remember({ content: "Uses pnpm not npm" });
    const second = await s.remember({ content: "  USES   pnpm not NPM " });
    expect(second.deduped).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
  });

  it("remember surfaces similar existing memories via full-text", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: a } = await s.remember({ content: "Deploy the frontend to Vercel for production hosting" });
    const res = await s.remember({ content: "We deploy the frontend to Vercel" });
    expect(res.deduped).toBe(false);
    expect(res.similar.map((m) => m.id)).toContain(a.id);
  });

  it("supersede onto existing content reuses the existing row as successor", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: target } = await s.remember({ content: "Deploy to Vercel" });
    const { memory: old } = await s.remember({ content: "Deploy to Netlify" });
    const successor = await s.supersede(old.id, "Deploy to Vercel");
    expect(successor.id).toBe(target.id);
    const { rows } = await pool.query("select status, superseded_by from memories where id=$1", [old.id]);
    expect(rows[0].status).toBe("superseded");
    expect(rows[0].superseded_by).toBe(target.id);
  });

  it("supersede with the same content just confirms it", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: m } = await s.remember({ content: "Deploy to Vercel" });
    const result = await s.supersede(m.id, "deploy   to VERCEL");
    expect(result.id).toBe(m.id);
    expect(result.status).toBe("active");
    expect(result.confidence).toBeGreaterThan(m.confidence);
  });

  it("a duplicate remember merges new metadata into the existing memory", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "Standup is at 10am", salience: 0.2 });
    const res = await s.remember({
      content: "Standup is at 10am",
      salience: 0.9,
      tags: ["schedule"],
      kind: "routine",
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    expect(res.deduped).toBe(true);
    expect(res.memory.salience).toBeCloseTo(0.9, 5);
    expect(res.memory.tags).toEqual(["schedule"]);
    expect(res.memory.kind).toBe("routine");
    expect(res.memory.expires_at).not.toBeNull();
  });

  it("an explicit confidence on a duplicate replaces instead of ratcheting up", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "Might switch to bun", confidence: 0.9 });
    const doubted = await s.remember({ content: "Might switch to bun", confidence: 0.2 });
    expect(doubted.deduped).toBe(true);
    expect(doubted.memory.confidence).toBeCloseTo(0.2, 5);
    const bumped = await s.remember({ content: "Might switch to bun" });
    expect(bumped.memory.confidence).toBeCloseTo(0.3, 4);
  });

  it("an explicit salience on a duplicate replaces, absent keeps the old value", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "Prefers pnpm", salience: 0.9 });
    const kept = await s.remember({ content: "Prefers pnpm" });
    expect(kept.memory.salience).toBeCloseTo(0.9, 5);
    const lowered = await s.remember({ content: "Prefers pnpm", salience: 0.3 });
    expect(lowered.memory.salience).toBeCloseTo(0.3, 5);
  });

  it("re-remembering an expired fact revives it", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "migration freeze active", expiresAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(await s.recall("migration freeze")).toHaveLength(0);
    const res = await s.remember({ content: "migration freeze active" });
    expect(res.deduped).toBe(true);
    expect(res.memory.expires_at).toBeNull();
    expect(await s.recall("migration freeze")).toHaveLength(1);
  });

  it("supersede inherits kind, tags, and salience from the predecessor", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: card } = await s.remember({
      content: "IDENTITY: Husnain v1", kind: "peer-card", salience: 0.9, tags: ["identity"],
    });
    const successor = await s.supersede(card.id, "IDENTITY: Husnain v2");
    expect(successor.kind).toBe("peer-card");
    expect(successor.salience).toBeCloseTo(0.9, 5);
    expect(successor.tags).toEqual(["identity"]);
    const ctx = await s.context();
    expect(ctx.peerCard!.content).toBe("IDENTITY: Husnain v2");
  });

  it("superseding an already-superseded memory throws instead of corrupting the chain", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: v1 } = await s.remember({ content: "Deploy to Netlify" });
    const v2 = await s.supersede(v1.id, "Deploy to Vercel");
    await expect(s.supersede(v1.id, "Deploy to Cloudflare")).rejects.toThrow(/already superseded/i);
    const { rows } = await pool.query("select superseded_by from memories where id=$1", [v1.id]);
    expect(rows[0].superseded_by).toBe(v2.id);
  });
});

describe("MemoryStore short ids", () => {
  it("resolves unique prefixes and rejects ambiguous or bad ones", async () => {
    await pool.query("insert into memories (id, namespace, content) values ('11111111-1111-4111-8111-111111111111', 'husnain', 'prefix fact one')");
    await pool.query("insert into memories (id, namespace, content) values ('11111111-2222-4222-8222-222222222222', 'husnain', 'prefix fact two')");
    const s = new MemoryStore(pool, "husnain");
    await expect(s.resolveId("11111111")).rejects.toThrow(/ambiguous/i);
    expect(await s.confirm("11111111-1")).toBe(true);
    expect(await s.resolveId("99999999")).toBeNull();
    expect(await s.forget("zzzz")).toBe(false);
    expect(await s.resolveId("1111")).toBeNull();
  });
});

describe("MemoryStore ranking and expiry", () => {
  it("higher salience wins between equally relevant memories", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "kubernetes cluster notes alpha", salience: 0.1 });
    await s.remember({ content: "kubernetes cluster notes beta", salience: 0.9 });
    const hits = await s.recall("kubernetes cluster notes");
    expect(hits[0].content).toMatch(/beta/);
  });

  it("expired memories stop surfacing in recall", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "temporary migration freeze until Friday", expiresAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(await s.recall("migration freeze")).toHaveLength(0);
  });

  it("recall bumps access_count on returned memories", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: m } = await s.remember({ content: "access tracking works" });
    expect(m.access_count).toBe(0);
    await s.recall("access tracking");
    await s.recall("access tracking");
    const [after] = await s.list();
    expect(after.access_count).toBe(2);
  });

  it("simple-config full-text matches tokens english stems away", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "the WAS gateway config for prod" });
    const hits = await s.recall("WAS");
    expect(hits.map((m) => m.content)).toContain("the WAS gateway config for prod");
  });

  it("records the source client from the client provider", async () => {
    const s = new MemoryStore(pool, "husnain", undefined, () => "codex");
    const { memory: m } = await s.remember({ content: "written from codex" });
    expect(m.client).toBe("codex");
  });
});

describe("MemoryStore.context", () => {
  it("returns peer-card, salient memories, and recent extras without duplicates", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "IDENTITY: Husnain builds GeoIPHub", kind: "peer-card" });
    await s.remember({ content: "Key architectural decision about Postgres", salience: 0.9 });
    await s.remember({ content: "Low value scratch note", salience: 0.1 });
    const ctx = await s.context();
    expect(ctx.peerCard!.content).toMatch(/IDENTITY/);
    expect(ctx.top.map((m) => m.content)).toContain("Key architectural decision about Postgres");
    expect(ctx.top.map((m) => m.kind)).not.toContain("peer-card");
    const topIds = new Set(ctx.top.map((m) => m.id));
    expect(ctx.recent.every((m) => !topIds.has(m.id))).toBe(true);
  });
});

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
    const { memory: m } = await s.remember({ content: "uses pnpm" });
    expect(m.confidence).toBeCloseTo(0.7, 5);
    await s.confirm(m.id);
    const [after] = await s.list();
    expect(after.confidence).toBeCloseTo(0.8, 4);
    for (let i = 0; i < 5; i++) await s.confirm(m.id);
    const [capped] = await s.list();
    expect(capped.confidence).toBeLessThanOrEqual(1.0001);
    expect(capped.confidence).toBeGreaterThan(0.99);
  });

  it("stale() returns active memories not confirmed within N days, oldest first", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: old } = await s.remember({ content: "old fact about kestrels" });
    await s.remember({ content: "fresh fact about otters" });
    await pool.query("update memories set last_confirmed_at = now() - interval '10 days' where id=$1", [old.id]);
    const stale = await s.stale(7);
    expect(stale.map((r) => r.content)).toContain("old fact about kestrels");
    expect(stale.map((r) => r.content)).not.toContain("fresh fact about otters");
  });

  it("stale() excludes archived/superseded memories", async () => {
    const s = new MemoryStore(pool, "husnain");
    const { memory: m } = await s.remember({ content: "archived stale thing" });
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
    const hits = await s.recall("hosting platform for deployment");
    expect(hits[0].content).toMatch(/Vercel/);
  });

  it("recall degrades to full-text when the embedder fails", async () => {
    const throwing: Embedder = { provider: "fake", model: "v1", dim: 3, async embed() { throw new Error("model down"); } };
    const s = new MemoryStore(pool, "husnain", throwing);
    await s.remember({ content: "Deploy the app to Vercel" });
    const hits = await s.recall("vercel");
    expect(hits[0].content).toMatch(/Vercel/);
  });

  it("remember surfaces similar existing memories via embeddings", async () => {
    const s = new MemoryStore(pool, "husnain", fakeEmbedder);
    const { memory: a } = await s.remember({ content: "We ship the frontend to Vercel" });
    const res = await s.remember({ content: "Hosting runs on the deploy platform" });
    expect(res.similar.map((m) => m.id)).toContain(a.id);
  });

  it("a duplicate remember backfills a missing embedding", async () => {
    const plain = new MemoryStore(pool, "husnain");
    const { memory: m } = await plain.remember({ content: "We ship the frontend to Vercel" });
    const withEmbedder = new MemoryStore(pool, "husnain", fakeEmbedder);
    const res = await withEmbedder.remember({ content: "We ship the frontend to Vercel" });
    expect(res.deduped).toBe(true);
    const { rows } = await pool.query("select 1 from memory_embeddings where memory_id=$1", [m.id]);
    expect(rows).toHaveLength(1);
  });

  it("supersede embeds the successor", async () => {
    const s = new MemoryStore(pool, "husnain", fakeEmbedder);
    const { memory: old } = await s.remember({ content: "We ship the frontend to Netlify" });
    const successor = await s.supersede(old.id, "We ship the frontend to Vercel");
    const { rows } = await pool.query("select 1 from memory_embeddings where memory_id=$1", [successor.id]);
    expect(rows).toHaveLength(1);
  });
});

describe("gated recall with embeddings", () => {
  const axes: Embedder = {
    provider: "axes", model: "v1", dim: 3,
    async embed(texts) {
      return texts.map((t) => {
        const s = t.toLowerCase();
        if (s.includes("clip") || s.includes("film") || s.includes("footage")) return [1, 0.1, 0];
        if (s.includes("invoice") || s.includes("tax")) return [0, 1, 0.1];
        return [0.1, 0, 1];
      });
    },
  };

  it("injects a semantically close memory with no shared words and nothing for a distant prompt", async () => {
    const s = new MemoryStore(pool, "husnain", axes);
    await s.remember({ content: "Footage should always be graded warm" });
    await s.remember({ content: "Invoices go out on the first of the month" });
    const hits = await s.recall("cut a short film clip", 3, { gate: true });
    expect(hits.map((h) => h.content)).toEqual(["Footage should always be graded warm"]);
    expect(await s.recall("water the garden", 3, { gate: true })).toEqual([]);
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

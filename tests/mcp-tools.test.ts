import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/store.js";
import { buildToolHandlers } from "../src/mcp/server.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });
beforeEach(async () => { await pool.query("delete from memories"); });

const shortId = (s: string) => {
  const m = s.match(/id ([0-9a-f]{8})\)/);
  expect(m).not.toBeNull();
  return m![1];
};

describe("tool handlers", () => {
  it("remember then recall returns a human-readable summary", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    const saved = await h.remember({ content: "Prefers tabs over spaces", kind: "preference" });
    expect(saved).toMatch(/remembered/i);
    const recalled = await h.recall({ query: "tabs spaces" });
    expect(recalled).toMatch(/tabs over spaces/);
  });

  it("recall reports nothing found cleanly", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    expect(await h.recall({ query: "nonexistent" })).toMatch(/no memories/i);
  });

  it("list, forget, confirm, supersede via handlers using short ids", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    const r = await h.remember({ content: "Uses pnpm not npm" });
    const id = shortId(r);

    expect(await h.list({})).toMatch(/pnpm/);
    expect(await h.confirm({ id })).toMatch(/confirmed/i);
    const supersedeResult = await h.supersede({ id, content: "Uses bun now" });
    expect(supersedeResult).toMatch(/bun/i);
    expect(await h.forget({ id })).toMatch(/no memory|forgot/i);
  });

  it("a duplicate remember reports the dedupe instead of saving twice", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    await h.remember({ content: "Same fact" });
    expect(await h.remember({ content: "Same fact" })).toMatch(/already known/i);
    const { rows } = await pool.query("select count(*)::int as n from memories where status='active'");
    expect(rows[0].n).toBe(1);
  });

  it("remember echoes similar existing memories with reconciliation guidance", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    await h.remember({ content: "Deploy the frontend to Vercel for production hosting" });
    const second = await h.remember({ content: "We deploy the frontend to Vercel" });
    expect(second).toMatch(/similar existing memories/i);
    expect(second).toMatch(/supersede or confirm/i);
  });

  it("context assembles peer-card, key, and recent sections", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    await h.remember({ content: "IDENTITY: Husnain builds GeoIPHub", kind: "peer-card" });
    await h.remember({ content: "Uses pnpm workspaces", salience: 0.9 });
    const ctx = await h.context();
    expect(ctx).toMatch(/PEER CARD/);
    expect(ctx).toMatch(/GeoIPHub/);
    expect(ctx).toMatch(/pnpm/);
  });

  it("context reports an empty store cleanly", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    expect(await h.context()).toMatch(/no memories yet/i);
  });

  it("handler error boundary returns Error string instead of throwing", async () => {
    const badPool = new Pool({ connectionString: "postgresql://bad:bad@localhost:1/bad" });
    const h = buildToolHandlers(new MemoryStore(badPool, "husnain"));
    const result = await h.recall({ query: "test" });
    expect(result).toMatch(/^Error:/);
    await badPool.end();
  });

  it("history surfaces the supersession chain via the handler", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    const r1 = await h.remember({ content: "Old fact v1" });
    const id1 = shortId(r1);
    const r2 = await h.supersede({ id: id1, content: "New fact v2" });
    const id2 = shortId(r2);
    const out = await h.history({ id: id2 });
    expect(out).toMatch(/New fact v2/);
    expect(out).toMatch(/Old fact v1/);
  });

  it("review surfaces stale memories and reports none cleanly", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    const saved = await h.remember({ content: "Stale config note" });
    const id = shortId(saved);
    await pool.query("update memories set last_confirmed_at = now() - interval '60 days' where id::text like $1", [id + "%"]);

    expect(await h.review({ days: 30 })).toMatch(/Stale config note/);
    expect(await h.review({ days: 90 })).toMatch(/no stale memories/i);
  });
});

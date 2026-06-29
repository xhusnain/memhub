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

  it("list, forget, confirm, supersede via handlers", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    const r = await h.remember({ content: "Uses pnpm not npm" });
    // fmt returns: Remembered: • content (note, conf 0.7, id <uuid>)
    const idMatch = r.match(/id ([0-9a-f-]{36})\)/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    expect(await h.list({})).toMatch(/pnpm/);
    expect(await h.confirm({ id })).toMatch(/confirmed/i);
    const supersedeResult = await h.supersede({ id, content: "Uses bun now" });
    expect(supersedeResult).toMatch(/bun/i);
    // After supersede the original id is archived; forget should return "No memory"
    expect(await h.forget({ id })).toMatch(/no memory|forgot/i);
  });

  it("handler error boundary returns Error string instead of throwing", async () => {
    // Use a closed pool to force a store error
    const badPool = new Pool({ connectionString: "postgresql://bad:bad@localhost:1/bad" });
    const h = buildToolHandlers(new MemoryStore(badPool, "husnain"));
    const result = await h.recall({ query: "test" });
    expect(result).toMatch(/^Error:/);
    await badPool.end();
  });

  it("history surfaces the supersession chain via the handler", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    const r1 = await h.remember({ content: "Old fact v1" });
    const id1 = r1.match(/id ([0-9a-f-]{36})/)![1];
    const r2 = await h.supersede({ id: id1, content: "New fact v2" });
    const id2 = r2.match(/id ([0-9a-f-]{36})/)![1];
    const out = await h.history({ id: id2 });
    expect(out).toMatch(/New fact v2/);
    expect(out).toMatch(/Old fact v1/);
  });

  it("review surfaces stale memories and reports none cleanly", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    const saved = await h.remember({ content: "Stale config note" });
    const id = saved.match(/id ([0-9a-f-]{36})/)![1];
    await pool.query("update memories set last_confirmed_at = now() - interval '60 days' where id=$1", [id]);

    expect(await h.review({ days: 30 })).toMatch(/Stale config note/);
    expect(await h.review({ days: 90 })).toMatch(/no stale memories/i);
  });
});

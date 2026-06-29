import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
});
afterAll(async () => { await pool.end(); await container.stop(); });

describe("migrate", () => {
  it("creates the memories table and is idempotent", async () => {
    await migrate(pool);
    await migrate(pool); // second run must not throw
    const { rows } = await pool.query(
      "select column_name from information_schema.columns where table_name='memories' order by column_name"
    );
    const cols = rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      "id","namespace","content","kind","tags","source","confidence",
      "status","superseded_by","created_at","last_confirmed_at","fts"
    ]));
    const meta = await pool.query("select to_regclass('public.memhub_meta') as t");
    expect(meta.rows[0].t).toBe("memhub_meta");
  });
});

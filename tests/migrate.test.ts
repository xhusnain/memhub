import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

const V1_SQL = `
CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL,
  content text NOT NULL,
  kind text,
  tags text[] NOT NULL DEFAULT '{}',
  source text,
  confidence real NOT NULL DEFAULT 0.7,
  level text NOT NULL DEFAULT 'explicit',
  status text NOT NULL DEFAULT 'active',
  superseded_by uuid REFERENCES memories(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE TABLE memhub_meta (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
`;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
});
afterAll(async () => { await pool.end(); await container.stop(); });

describe("migrate", () => {
  it("creates the memories table with v2 columns and is idempotent", async () => {
    await migrate(pool);
    await migrate(pool);
    const { rows } = await pool.query(
      "select column_name from information_schema.columns where table_name='memories' order by column_name"
    );
    const cols = rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      "id", "namespace", "content", "kind", "tags", "source", "confidence",
      "status", "superseded_by", "created_at", "last_confirmed_at", "fts",
      "content_hash", "salience", "client", "observed_at", "expires_at",
      "access_count", "last_accessed_at", "fts_simple",
    ]));
    const meta = await pool.query("select to_regclass('public.memhub_meta') as t");
    expect(meta.rows[0].t).toBe("memhub_meta");
    const version = await pool.query("select value from memhub_meta where key='schema_version'");
    expect(version.rows[0].value).toBe("2");
  });

  it("upgrades a v1 database: hashes content, archives duplicates, enforces uniqueness", async () => {
    await pool.query("drop table if exists memories cascade");
    await pool.query("drop table if exists memhub_meta");
    await pool.query(V1_SQL);
    await pool.query(
      "insert into memories (namespace, content) values ('h', 'Same fact'), ('h', 'Same fact'), ('h', '  same   FACT '), ('h', 'Other fact')"
    );
    await migrate(pool);
    const active = await pool.query("select content from memories where status='active' and namespace='h'");
    expect(active.rows).toHaveLength(2);
    const archived = await pool.query("select count(*)::int as n from memories where status='archived' and namespace='h'");
    expect(archived.rows[0].n).toBe(2);
    const idx = await pool.query("select 1 from pg_indexes where indexname='memories_active_hash_idx'");
    expect(idx.rows).toHaveLength(1);
    const hashes = await pool.query("select count(*)::int as n from memories where content_hash is null");
    expect(hashes.rows[0].n).toBe(0);
    await expect(
      pool.query("insert into memories (namespace, content) values ('h', 'same FACT')")
    ).rejects.toThrow(/duplicate key/);
  });
});

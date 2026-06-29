import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { migrateEmbeddings } from "../src/db/migrate-embeddings.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });

describe("migrateEmbeddings", () => {
  it("creates the vector extension and memory_embeddings table, idempotently", async () => {
    await migrateEmbeddings(pool);
    await migrateEmbeddings(pool); // idempotent
    const ext = await pool.query("select 1 from pg_extension where extname='vector'");
    expect(ext.rowCount).toBe(1);
    const cols = (await pool.query(
      "select column_name from information_schema.columns where table_name='memory_embeddings' order by column_name"
    )).rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(["memory_id","provider","model","dim","embedding"]));
  });

  it("cascades deletes from memories to memory_embeddings", async () => {
    const { rows } = await pool.query(
      "insert into memories (namespace, content) values ('t','hello') returning id"
    );
    const id = rows[0].id;
    await pool.query(
      `insert into memory_embeddings (memory_id, provider, model, dim, embedding)
       values ($1,'fake','v1',3,$2::vector)`,
      [id, "[1,2,3]"]
    );
    expect((await pool.query("select 1 from memory_embeddings where memory_id=$1", [id])).rowCount).toBe(1);

    await pool.query("delete from memories where id=$1", [id]);
    expect((await pool.query("select 1 from memory_embeddings where memory_id=$1", [id])).rowCount).toBe(0);
  });
});

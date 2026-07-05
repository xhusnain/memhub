import type { Pool } from "pg";
import { EMBEDDINGS_SQL } from "./embeddings-schema.js";

export async function migrateEmbeddings(pool: Pool): Promise<void> {
  const conn = await pool.connect();
  try {
    const { rows } = await conn.query("select to_regclass('public.memory_embeddings') as t");
    if (rows[0]?.t) return;
    await conn.query("begin");
    try {
      await conn.query("select pg_advisory_xact_lock(hashtext('memhub:ddl'), 0)");
      await conn.query(EMBEDDINGS_SQL);
      await conn.query("commit");
    } catch (e) {
      try { await conn.query("rollback"); } catch {}
      throw e;
    }
  } finally {
    conn.release();
  }
}

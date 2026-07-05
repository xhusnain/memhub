import type { Pool } from "pg";
import { SCHEMA_SQL, BACKFILL_SQL, HASH_INDEX_SQL, SCHEMA_VERSION } from "./schema.js";

const META_SQL = `CREATE TABLE IF NOT EXISTS memhub_meta (
  key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
)`;

export async function migrate(pool: Pool): Promise<void> {
  const conn = await pool.connect();
  try {
    try {
      const { rows } = await conn.query("select value from memhub_meta where key='schema_version'");
      if (rows[0]?.value === SCHEMA_VERSION) return;
    } catch {}
    await conn.query("begin");
    try {
      await conn.query("select pg_advisory_xact_lock(hashtext('memhub:ddl'), 0)");
      await conn.query(META_SQL);
      const { rows: again } = await conn.query("select value from memhub_meta where key='schema_version'");
      if (again[0]?.value !== SCHEMA_VERSION) {
        await conn.query(SCHEMA_SQL);
        await conn.query(BACKFILL_SQL);
        await conn.query(HASH_INDEX_SQL);
        await conn.query(
          `insert into memhub_meta (key, value, updated_at) values ('schema_version', $1, now())
           on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [SCHEMA_VERSION]
        );
      }
      await conn.query("commit");
    } catch (e) {
      try { await conn.query("rollback"); } catch {}
      throw e;
    }
  } finally {
    conn.release();
  }
}

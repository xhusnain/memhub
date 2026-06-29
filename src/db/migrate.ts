import type { Pool } from "pg";
import { SCHEMA_SQL } from "./schema.js";

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

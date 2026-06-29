import type { Pool } from "pg";
import { EMBEDDINGS_SQL } from "./embeddings-schema.js";

export async function migrateEmbeddings(pool: Pool): Promise<void> {
  await pool.query(EMBEDDINGS_SQL);
}

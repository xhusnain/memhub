export const EMBEDDINGS_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  provider   text NOT NULL,
  model      text NOT NULL,
  dim        int  NOT NULL,
  embedding  vector NOT NULL,
  PRIMARY KEY (memory_id, provider, model)
);
CREATE INDEX IF NOT EXISTS memory_embeddings_lookup_idx
  ON memory_embeddings (provider, model);
`;

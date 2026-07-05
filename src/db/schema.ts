export const SCHEMA_VERSION = "2";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace         text NOT NULL,
  content           text NOT NULL,
  kind              text,
  tags              text[] NOT NULL DEFAULT '{}',
  source            text,
  confidence        real NOT NULL DEFAULT 0.7,
  level             text NOT NULL DEFAULT 'explicit',
  status            text NOT NULL DEFAULT 'active',
  superseded_by     uuid REFERENCES memories(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  fts               tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS memories_namespace_idx ON memories (namespace);
CREATE INDEX IF NOT EXISTS memories_fts_idx ON memories USING gin (fts);
CREATE INDEX IF NOT EXISTS memories_status_idx ON memories (namespace, status);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS level text NOT NULL DEFAULT 'explicit';
CREATE INDEX IF NOT EXISTS memories_level_idx ON memories (namespace, level, status);
CREATE TABLE IF NOT EXISTS memhub_meta (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash text
  GENERATED ALWAYS AS (md5(lower(regexp_replace(btrim(content), '\\s+', ' ', 'g')))) STORED;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS salience real NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS client text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS observed_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count int NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS fts_simple tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
CREATE INDEX IF NOT EXISTS memories_fts_simple_idx ON memories USING gin (fts_simple);
`;

export const BACKFILL_SQL = `
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY namespace, content_hash
    ORDER BY last_confirmed_at DESC, created_at DESC
  ) AS rn FROM memories WHERE status = 'active'
)
UPDATE memories m SET status = 'archived' FROM ranked r WHERE m.id = r.id AND r.rn > 1;
`;

export const HASH_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS memories_active_hash_idx
  ON memories (namespace, content_hash) WHERE status = 'active';
`;

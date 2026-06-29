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
`;

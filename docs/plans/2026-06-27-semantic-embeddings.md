# Semantic Embeddings (Plan 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add optional semantic recall — a pluggable embedder layer (OpenAI + Ollama), a pgvector-backed `memory_embeddings` table, and hybrid (full-text + vector) ranking — without breaking the zero-config full-text default.

**Architecture:** Embeddings stay **optional**. When a provider is configured, an additional pgvector migration runs and `MemoryStore` embeds each new memory and stores the vector; `recall` then blends full-text and vector results via Reciprocal Rank Fusion (RRF). When the provider is `none`, nothing changes — bare Postgres + full-text, exactly as today. Adapters are tested with a mocked `fetch` (no real API); hybrid recall is tested with a deterministic fake embedder against real pgvector Postgres.

**Tech Stack:** Same as prior milestones — Node ≥20, TypeScript (ESM, strict), `pg`, `zod`, `@clack/prompts`, `vitest` + `@testcontainers/postgresql`, `tsup`. New: pgvector (via the `pgvector/pgvector:pg16` test image and `CREATE EXTENSION vector`); Node global `fetch` for adapters (injectable).

## Global Constraints

- Node ≥ 20, ESM, TypeScript strict.
- **No required LLM key.** OpenAI is one optional provider; Ollama (local, free) is the no-key path. Embeddings remain optional with full-text fallback.
- The base migration must keep working on bare Postgres **without** pgvector. The vector extension/table is created **only** when a provider is configured (a separate `migrateEmbeddings`).
- Adapter unit tests must NOT hit a real network — inject a fake `fetch`. Hybrid-recall tests use a deterministic fake embedder against real pgvector Postgres (image `pgvector/pgvector:pg16`).
- A memory must still be saved even if embedding fails (degrade to full-text; never lose the fact).
- Secrets (embedding API keys) live only in the global config (`~/.claude-memory/config.json`), never logged.
- Recall is namespace-scoped on every query (carry-over invariant).
- Package/bin name: `claude-memory`. MIT.

---

## File Structure

- Create: `src/db/embeddings-schema.ts` — vector extension + `memory_embeddings` SQL string.
- Create: `src/db/migrate-embeddings.ts` — `migrateEmbeddings(pool)`.
- Create: `tests/migrate-embeddings.test.ts`.
- Create: `src/embeddings/types.ts` — `Embedder` interface.
- Create: `src/embeddings/openai.ts` + `tests/embeddings-openai.test.ts`.
- Create: `src/embeddings/ollama.ts` + `tests/embeddings-ollama.test.ts`.
- Create: `src/embeddings/registry.ts` — `createEmbedder(config, fetchImpl?)`.
- Modify: `src/db/store.ts` — accept an optional `Embedder`; store vectors on `remember`; hybrid `recall`.
- Modify: `tests/store.test.ts` — add a fake-embedder hybrid-recall test (pgvector image).
- Modify: `src/config.ts` + `tests/config.test.ts` — embeddings discriminated union.
- Modify: `src/wizard/init.ts` + `tests/init.test.ts` — prompt provider/creds; run `migrateEmbeddings` when enabled.
- Modify: `src/mcp/server.ts` — build embedder from config, run `migrateEmbeddings` when enabled, pass embedder to `MemoryStore`.

---

### Task 1: Embeddings schema + conditional migration

**Files:**
- Create: `src/db/embeddings-schema.ts`, `src/db/migrate-embeddings.ts`, `tests/migrate-embeddings.test.ts`

**Interfaces:**
- Produces: `migrateEmbeddings(pool: Pool): Promise<void>` — creates the `vector` extension + `memory_embeddings` table; idempotent; assumes the base `memories` table already exists (from `migrate`).

- [ ] **Step 1: Write the failing test `tests/migrate-embeddings.test.ts`**

```ts
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
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/migrate-embeddings.test.ts`
Expected: FAIL — cannot import `migrate-embeddings.js`.

- [ ] **Step 3: Write `src/db/embeddings-schema.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/db/migrate-embeddings.ts`**

```ts
import type { Pool } from "pg";
import { EMBEDDINGS_SQL } from "./embeddings-schema.js";

export async function migrateEmbeddings(pool: Pool): Promise<void> {
  await pool.query(EMBEDDINGS_SQL);
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run tests/migrate-embeddings.test.ts`
Expected: PASS (uses the `pgvector/pgvector:pg16` image — first run pulls it).

- [ ] **Step 6: Commit**

```bash
git add src/db/embeddings-schema.ts src/db/migrate-embeddings.ts tests/migrate-embeddings.test.ts
git commit -m "feat: conditional pgvector embeddings schema + migration"
```

---

### Task 2: Embedder interface + OpenAI adapter

**Files:**
- Create: `src/embeddings/types.ts`, `src/embeddings/openai.ts`, `tests/embeddings-openai.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  interface Embedder { provider: string; model: string; dim: number; embed(texts: string[]): Promise<number[][]>; }
  type FetchFn = typeof fetch;
  // openai.ts
  function openaiEmbedder(opts: { model: string; apiKey: string; baseUrl?: string; dim?: number; fetchImpl?: FetchFn }): Embedder;
  ```

- [ ] **Step 1: Write the failing test `tests/embeddings-openai.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { openaiEmbedder } from "../src/embeddings/openai.js";

describe("openaiEmbedder", () => {
  it("posts to the embeddings endpoint with auth and parses vectors", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }) } as any;
    }) as unknown as typeof fetch;

    const e = openaiEmbedder({ model: "text-embedding-3-small", apiKey: "sk-test", fetchImpl });
    expect(e.provider).toBe("openai");
    expect(e.dim).toBe(1536);

    const out = await e.embed(["a", "b"]);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(calls[0].url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0].init.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] });
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429, json: async () => ({}) } as any)) as unknown as typeof fetch;
    const e = openaiEmbedder({ model: "text-embedding-3-small", apiKey: "x", fetchImpl });
    await expect(e.embed(["a"])).rejects.toThrow(/openai.*429/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/embeddings-openai.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `src/embeddings/types.ts`**

```ts
export interface Embedder {
  provider: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
export type FetchFn = typeof fetch;
```

- [ ] **Step 4: Write `src/embeddings/openai.ts`**

```ts
import type { Embedder, FetchFn } from "./types.js";

const OPENAI_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export function openaiEmbedder(opts: {
  model: string; apiKey: string; baseUrl?: string; dim?: number; fetchImpl?: FetchFn;
}): Embedder {
  const base = opts.baseUrl ?? "https://api.openai.com/v1";
  const dim = opts.dim ?? OPENAI_DIMS[opts.model] ?? 1536;
  const f: FetchFn = opts.fetchImpl ?? fetch;
  return {
    provider: "openai",
    model: opts.model,
    dim,
    async embed(texts) {
      const res = await f(`${base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: opts.model, input: texts }),
      });
      if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data.map((d) => d.embedding);
    },
  };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run tests/embeddings-openai.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/embeddings/types.ts src/embeddings/openai.ts tests/embeddings-openai.test.ts
git commit -m "feat: Embedder interface and OpenAI adapter"
```

---

### Task 3: Ollama adapter (local, no key)

**Files:**
- Create: `src/embeddings/ollama.ts`, `tests/embeddings-ollama.test.ts`

**Interfaces:**
- Consumes: `Embedder`, `FetchFn` from `types.ts`.
- Produces: `function ollamaEmbedder(opts: { model: string; baseUrl?: string; dim?: number; fetchImpl?: FetchFn }): Embedder;`

- [ ] **Step 1: Write the failing test `tests/embeddings-ollama.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ollamaEmbedder } from "../src/embeddings/ollama.js";

describe("ollamaEmbedder", () => {
  it("posts to /api/embed and parses the embeddings array", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => ({ embeddings: [[1, 2, 3], [4, 5, 6]] }) } as any;
    }) as unknown as typeof fetch;

    const e = ollamaEmbedder({ model: "nomic-embed-text", fetchImpl });
    expect(e.provider).toBe("ollama");
    expect(e.dim).toBe(768);

    const out = await e.embed(["a", "b"]);
    expect(out).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(calls[0].url).toBe("http://localhost:11434/api/embed");
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) } as any)) as unknown as typeof fetch;
    const e = ollamaEmbedder({ model: "nomic-embed-text", fetchImpl });
    await expect(e.embed(["a"])).rejects.toThrow(/ollama.*500/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/embeddings-ollama.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `src/embeddings/ollama.ts`**

```ts
import type { Embedder, FetchFn } from "./types.js";

const OLLAMA_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "bge-m3": 1024,
};

export function ollamaEmbedder(opts: {
  model: string; baseUrl?: string; dim?: number; fetchImpl?: FetchFn;
}): Embedder {
  const base = opts.baseUrl ?? "http://localhost:11434";
  const dim = opts.dim ?? OLLAMA_DIMS[opts.model] ?? 768;
  const f: FetchFn = opts.fetchImpl ?? fetch;
  return {
    provider: "ollama",
    model: opts.model,
    dim,
    async embed(texts) {
      const res = await f(`${base}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, input: texts }),
      });
      if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
      const json = (await res.json()) as { embeddings: number[][] };
      return json.embeddings;
    },
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/embeddings-ollama.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/embeddings/ollama.ts tests/embeddings-ollama.test.ts
git commit -m "feat: Ollama embedder adapter (local, no key)"
```

---

### Task 4: Store embeddings + hybrid recall

**Files:**
- Modify: `src/db/store.ts`
- Modify: `tests/store.test.ts`

**Interfaces:**
- Consumes: `Embedder` (`../embeddings/types.js`), `migrateEmbeddings`.
- Produces (updated `MemoryStore`):
  ```ts
  class MemoryStore {
    constructor(pool: Pool, namespace: string, embedder?: Embedder); // embedder optional; absent => FTS only
    // remember(): if embedder present, also embeds + stores the vector (best-effort; a failed embed never blocks the save)
    // recall(query, k?): if embedder present -> hybrid (full-text + vector via RRF); else -> full-text only (unchanged)
  }
  ```
- Helper (not exported): `rrfMerge(lists: Memory[][], k: number): Memory[]` — Reciprocal Rank Fusion with constant 60, dedupe by `id`.
- Vector encoding: numbers serialized as a pgvector literal string `'[' + v.join(',') + ']'`, bound as `$n::vector`.

- [ ] **Step 1: Add the failing hybrid-recall test to `tests/store.test.ts`**

Use the `pgvector/pgvector:pg16` image for this file's container and run `migrateEmbeddings` in `beforeAll`. Add a deterministic fake embedder and a test that proves semantic recall finds a memory with NO shared words with the query. Append:

```ts
import { migrateEmbeddings } from "../src/db/migrate-embeddings.js";
import type { Embedder } from "../src/embeddings/types.js";

// deterministic 3-dim embedder: dimensions = presence of [deploy, coffee, database] concepts
const fakeEmbedder: Embedder = {
  provider: "fake", model: "v1", dim: 3,
  async embed(texts) {
    return texts.map((t) => {
      const s = t.toLowerCase();
      return [
        (s.includes("vercel") || s.includes("deploy") || s.includes("ship") || s.includes("host")) ? 1 : 0,
        (s.includes("coffee") || s.includes("espresso") || s.includes("latte")) ? 1 : 0,
        (s.includes("postgres") || s.includes("database") || s.includes("sql")) ? 1 : 0,
      ];
    });
  },
};

describe("MemoryStore hybrid recall (pgvector)", () => {
  it("recalls a semantically related memory with no shared words", async () => {
    await migrateEmbeddings(pool);
    const s = new MemoryStore(pool, "husnain", fakeEmbedder);
    await s.remember({ content: "We ship the frontend to Vercel" });
    await s.remember({ content: "Espresso with oat milk in the morning" });

    // "hosting platform for deployment" shares NO words with the Vercel memory,
    // but is semantically close on the deploy dimension.
    const hits = await s.recall("hosting platform for deployment");
    expect(hits[0].content).toMatch(/Vercel/);
  });
});
```

Note: this file already has a `postgres:16` container in `beforeAll`. Change that container image to `pgvector/pgvector:pg16` and add `await migrateEmbeddings(pool)` after `migrate(pool)` in the existing `beforeAll`, so both the existing FTS tests and the new hybrid test share one container. The existing FTS tests must still pass unchanged.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — constructor doesn't accept an embedder / hybrid recall not implemented (Vercel memory not returned for the wordless query).

- [ ] **Step 3: Update `src/db/store.ts`**

Add the embedder, the vector write in `remember`, and hybrid `recall`. Full new file content for the changed parts:

```ts
import type { Pool, PoolClient } from "pg";
import type { Embedder } from "../embeddings/types.js";

export type Memory = {
  id: string; namespace: string; content: string; kind: string | null;
  tags: string[]; source: string | null; confidence: number;
  status: string; created_at: string; last_confirmed_at: string;
};

const COLS = `id, namespace, content, kind, tags, source, confidence, status,
  created_at::text, last_confirmed_at::text`;

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function rrfMerge(lists: Memory[][], k: number): Memory[] {
  const score = new Map<string, number>();
  const byId = new Map<string, Memory>();
  for (const list of lists) {
    list.forEach((m, rank) => {
      byId.set(m.id, m);
      score.set(m.id, (score.get(m.id) ?? 0) + 1 / (60 + rank));
    });
  }
  return [...byId.values()]
    .sort((a, b) => (score.get(b.id)! - score.get(a.id)!))
    .slice(0, k);
}

export class MemoryStore {
  constructor(private pool: Pool, private namespace: string, private embedder?: Embedder) {}

  private async insertMemory(exec: Pool | PoolClient, input: { content: string; kind?: string; tags?: string[]; source?: string; confidence?: number }): Promise<Memory> {
    const { rows } = await exec.query(
      `insert into memories (namespace, content, kind, tags, source, confidence)
       values ($1,$2,$3,$4,$5,$6) returning ${COLS}`,
      [this.namespace, input.content, input.kind ?? null, input.tags ?? [],
       input.source ?? null, input.confidence ?? 0.7]
    );
    return rows[0];
  }

  async remember(input: { content: string; kind?: string; tags?: string[]; source?: string; confidence?: number }): Promise<Memory> {
    const memory = await this.insertMemory(this.pool, input);
    if (this.embedder) {
      // best-effort: a failed embed must never lose the memory
      try {
        const [vec] = await this.embedder.embed([memory.content]);
        await this.pool.query(
          `insert into memory_embeddings (memory_id, provider, model, dim, embedding)
           values ($1,$2,$3,$4,$5::vector)
           on conflict (memory_id, provider, model) do update set embedding = excluded.embedding`,
          [memory.id, this.embedder.provider, this.embedder.model, this.embedder.dim, toVectorLiteral(vec)]
        );
      } catch {
        // degrade to full-text only
      }
    }
    return memory;
  }

  private async ftsRecall(query: string, k: number): Promise<Memory[]> {
    const { rows } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active'
         and fts @@ websearch_to_tsquery('english', $2)
       order by ts_rank(fts, websearch_to_tsquery('english', $2)) desc
       limit $3`,
      [this.namespace, query, k]
    );
    return rows;
  }

  private async vectorRecall(query: string, k: number): Promise<Memory[]> {
    if (!this.embedder) return [];
    const [vec] = await this.embedder.embed([query]);
    const { rows } = await this.pool.query(
      `select ${COLS.split(",").map(c => "m." + c.trim()).join(", ")}
       from memories m
       join memory_embeddings e on e.memory_id = m.id
       where m.namespace=$1 and m.status='active'
         and e.provider=$2 and e.model=$3
       order by e.embedding <=> $4::vector
       limit $5`,
      [this.namespace, this.embedder.provider, this.embedder.model, toVectorLiteral(vec), k]
    );
    return rows;
  }

  async recall(query: string, k = 8): Promise<Memory[]> {
    if (!this.embedder) return this.ftsRecall(query, k);
    const [fts, vec] = await Promise.all([
      this.ftsRecall(query, k),
      this.vectorRecall(query, k),
    ]);
    return rrfMerge([vec, fts], k);
  }

  async list(filter: { kind?: string; status?: string } = {}): Promise<Memory[]> {
    const { rows } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1
         and ($2::text is null or kind=$2)
         and ($3::text is null or status=$3)
       order by created_at desc`,
      [this.namespace, filter.kind ?? null, filter.status ?? null]
    );
    return rows;
  }

  async forget(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update memories set status='archived' where id=$1 and namespace=$2`,
      [id, this.namespace]
    );
    return (rowCount ?? 0) === 1;
  }

  async confirm(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update memories set last_confirmed_at=now() where id=$1 and namespace=$2`,
      [id, this.namespace]
    );
    return (rowCount ?? 0) === 1;
  }

  async supersede(oldId: string, newContent: string): Promise<Memory> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const fresh = await this.insertMemory(client, { content: newContent });
      const { rowCount } = await client.query(
        `update memories set status='superseded', superseded_by=$1
         where id=$2 and namespace=$3`,
        [fresh.id, oldId, this.namespace]
      );
      if ((rowCount ?? 0) !== 1) {
        await client.query("rollback");
        throw new Error(`No memory ${oldId} to supersede.`);
      }
      await client.query("commit");
      return fresh;
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }
}
```

Note: `supersede` only writes the memories row inside the transaction; its embedding is not added here (the superseding fact is a fresh row — if you want it embedded, that is a future enhancement; do NOT block this task on it). Keep behavior to what the test asserts.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS — all prior FTS tests plus the new hybrid test (Vercel memory returned for the wordless query).

- [ ] **Step 5: Commit**

```bash
git add src/db/store.ts tests/store.test.ts
git commit -m "feat: store embeddings on remember and hybrid (FTS+vector) recall via RRF"
```

---

### Task 5: Config union + registry + wizard/server wiring

**Files:**
- Create: `src/embeddings/registry.ts`, `tests/embeddings-registry.test.ts`
- Modify: `src/config.ts`, `tests/config.test.ts`
- Modify: `src/wizard/init.ts`, `tests/init.test.ts`
- Modify: `src/mcp/server.ts`

**Interfaces:**
- Consumes: `openaiEmbedder`, `ollamaEmbedder`, `Embedder`, `Config`.
- Produces:
  ```ts
  // registry.ts
  function createEmbedder(cfg: Config["embeddings"], fetchImpl?: FetchFn): Embedder | null; // null for "none"
  // config.ts embeddings union:
  //   { provider: "none" }
  // | { provider: "openai", model: string, apiKey: string, baseUrl?: string }
  // | { provider: "ollama", model: string, baseUrl?: string }
  ```

- [ ] **Step 1: Write `tests/embeddings-registry.test.ts` (failing)**

```ts
import { describe, it, expect } from "vitest";
import { createEmbedder } from "../src/embeddings/registry.js";

describe("createEmbedder", () => {
  it("returns null for none", () => {
    expect(createEmbedder({ provider: "none" })).toBeNull();
  });
  it("builds an openai embedder", () => {
    const e = createEmbedder({ provider: "openai", model: "text-embedding-3-small", apiKey: "x" });
    expect(e?.provider).toBe("openai");
    expect(e?.dim).toBe(1536);
  });
  it("builds an ollama embedder", () => {
    const e = createEmbedder({ provider: "ollama", model: "nomic-embed-text" });
    expect(e?.provider).toBe("ollama");
    expect(e?.dim).toBe(768);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/embeddings-registry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Update `src/config.ts` embeddings schema**

Replace the `embeddings` field in `ConfigSchema` with a discriminated union (keep everything else in the file unchanged):

```ts
const EmbeddingsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("none") }),
  z.object({ provider: z.literal("openai"), model: z.string().min(1), apiKey: z.string().min(1), baseUrl: z.string().optional() }),
  z.object({ provider: z.literal("ollama"), model: z.string().min(1), baseUrl: z.string().optional() }),
]);

const ConfigSchema = z.object({
  postgresUrl: z.string().min(1),
  namespace: z.string().min(1),
  captureMode: z.enum(["auto", "manual"]),
  embeddings: EmbeddingsSchema,
});
```

- [ ] **Step 4: Write `src/embeddings/registry.ts`**

```ts
import type { Config } from "../config.js";
import type { Embedder, FetchFn } from "./types.js";
import { openaiEmbedder } from "./openai.js";
import { ollamaEmbedder } from "./ollama.js";

export function createEmbedder(cfg: Config["embeddings"], fetchImpl?: FetchFn): Embedder | null {
  switch (cfg.provider) {
    case "none": return null;
    case "openai": return openaiEmbedder({ model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, fetchImpl });
    case "ollama": return ollamaEmbedder({ model: cfg.model, baseUrl: cfg.baseUrl, fetchImpl });
  }
}
```

- [ ] **Step 5: Add a config-union test to `tests/config.test.ts`**

Add (keep existing tests; update the existing round-trip cfg to include an embeddings value that is valid under the union, e.g. `{ provider: "none" }` which already is):

```ts
it("round-trips an openai embeddings config", () => {
  const base = mkdtempSync(join(tmpdir(), "cm-"));
  const cfg = { postgresUrl: "postgres://x", namespace: "h", captureMode: "auto" as const,
    embeddings: { provider: "openai" as const, model: "text-embedding-3-small", apiKey: "sk" } };
  saveConfig(cfg, base);
  expect(loadConfig(base)).toEqual(cfg);
});
```

- [ ] **Step 6: Wire `src/mcp/server.ts` to build an embedder + run the embeddings migration**

In `serve()`, after loading config and before constructing `MemoryStore`, add:

```ts
import { createEmbedder } from "../embeddings/registry.js";
import { migrateEmbeddings } from "../db/migrate-embeddings.js";
// ...
  const embedder = createEmbedder(cfg.embeddings);
  if (embedder) await migrateEmbeddings(pool);
  const handlers = buildToolHandlers(new MemoryStore(pool, cfg.namespace, embedder ?? undefined));
```

(Replace the existing `MemoryStore` construction line. Everything else in `serve()` is unchanged.)

- [ ] **Step 7: Update the wizard to prompt for a provider — `src/wizard/init.ts`**

Extend `runInitWith` to gather embeddings after capture mode, run `migrateEmbeddings` when not "none", and save the union. Add a helper that turns prompt answers into the embeddings config:

```ts
import { migrateEmbeddings } from "../db/migrate-embeddings.js";
import type { Config } from "../config.js";
// ...
async function promptEmbeddings(prompt: (q: string) => Promise<string>): Promise<Config["embeddings"]> {
  const provider = (await prompt("Embeddings provider — none / openai / ollama [none]")).trim().toLowerCase();
  if (provider === "openai") {
    const model = (await prompt("OpenAI embedding model [text-embedding-3-small]")).trim() || "text-embedding-3-small";
    const apiKey = (await prompt("OpenAI API key")).trim();
    return { provider: "openai", model, apiKey };
  }
  if (provider === "ollama") {
    const model = (await prompt("Ollama embedding model [nomic-embed-text]")).trim() || "nomic-embed-text";
    return { provider: "ollama", model };
  }
  return { provider: "none" };
}
```

Then in `runInitWith`, after reading `captureMode` and before `connect`:

```ts
  const embeddings = await promptEmbeddings(deps.prompt);
```

and after `migrate(pool)` (while the pool is still open, before `pool.end()`):

```ts
  if (embeddings.provider !== "none") await migrateEmbeddings(pool);
```

and change `saveConfig(...)` to pass `embeddings` instead of the hardcoded `{ provider: "none" }`.

- [ ] **Step 8: Update `tests/init.test.ts`**

The wizard now asks a 4th question (embeddings provider). Update the `answers` arrays: the auto test becomes `[url, "husnain", "auto", "none"]` and the manual test `[url, "husnain", "manual", "none"]`. Assert `cfg.embeddings.provider === "none"` in both. (Container image stays `postgres:16` — the "none" path does not touch pgvector.)

- [ ] **Step 9: Full gate**

Run: `npm test && npm run build && npm run typecheck`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/config.ts src/embeddings/registry.ts tests/embeddings-registry.test.ts tests/config.test.ts src/mcp/server.ts src/wizard/init.ts tests/init.test.ts
git commit -m "feat: embeddings config union, registry, wizard + server wiring"
```

---

## Self-Review

**Spec coverage (Plan 2 / M2):**
- pgvector `memory_embeddings` table, conditional (§5, §7) → Task 1. ✓
- Pluggable adapters, OpenAI + Ollama (the no-key path) (§7) → Tasks 2, 3; registry → Task 5. ✓
- Hybrid full-text + vector recall (§6/§7) → Task 4 (RRF). ✓
- Embeddings optional with full-text fallback (Global Constraints) → Task 4 (`embedder?` absent ⇒ FTS), Task 5 (`none` ⇒ null, no pgvector migration). ✓
- A failed embed never loses the memory (Global Constraints) → Task 4 (`try/catch` around the vector write). ✓
- No required LLM key (Global Constraints) → Ollama is keyless; default provider stays `none`. ✓
- Namespace-scoped on every query → Task 4 vector + FTS queries both filter `namespace`. ✓
- Secrets only in global config, never logged → Task 5 (apiKey in config; nothing logs it). ✓
- Deferred (correctly out of scope): Cloudflare/Gemini/Voyage adapters (mechanical follow-ons using the same interface); embedding the superseding memory; ANN index (exact search is fine at personal scale).

**Placeholder scan:** every code step shows full code; no TBD/"handle errors"/"similar to".

**Type consistency:** `Embedder` shape identical across types/openai/ollama/registry/store; `createEmbedder(cfg.embeddings, fetchImpl?)` matches the `Config["embeddings"]` union (Task 5); `MemoryStore` 3-arg constructor consistent between Task 4 and the Task 5 server wiring; `migrateEmbeddings(pool)` signature consistent across Tasks 1/4/5.

**Note for executor:** Tasks 1 and 4 require the `pgvector/pgvector:pg16` image (first run pulls it; Docker must be up). Task 4 changes `tests/store.test.ts`'s container image from `postgres:16` to `pgvector/pgvector:pg16` and adds `migrateEmbeddings` to its `beforeAll`; the existing FTS tests must keep passing. Tasks 2, 3, 5(registry/config) need no Docker.

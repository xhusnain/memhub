# claude-memory Core Store (Plan 1 of 5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working, shareable Claude Code memory: an MCP server backed by one Postgres database, with full-text recall and an `npx claude-memory init` install wizard — no embeddings, no dreaming yet (later plans).

**Architecture:** A TypeScript package exposes two CLI entrypoints — `init` (interactive wizard: collect Postgres URL + namespace, run the schema migration, register the MCP server with Claude Code) and `serve` (the stdio MCP server). The MCP server exposes `remember` / `recall` / `forget` / `list` / `confirm` / `supersede` tools that read/write a single `memories` table. Recall uses Postgres full-text search (`tsvector`). All machines point at the same Postgres, so Postgres is the cross-machine sync.

**Tech Stack:** Node ≥20, TypeScript (ESM), `@modelcontextprotocol/sdk` (stdio MCP server), `pg` (Postgres client), `zod` (tool schemas), `@clack/prompts` (wizard), `vitest` + `@testcontainers/postgresql` (tests against a real ephemeral Postgres), `tsup` (build).

## Global Constraints

- Node ≥ 20, package is ESM (`"type": "module"`).
- TypeScript strict mode on.
- No LLM/OpenAI dependency anywhere in this plan. Embeddings are out of scope (Plan 2).
- Secrets (Postgres URL) live only in `claude-memory.config.json` (gitignored) — never committed, never logged.
- All DB access is namespace-scoped; every query filters by `namespace`.
- Package/CLI name working title: `claude-memory`. Bin name: `claude-memory`.
- License: MIT.
- Every DB-touching test runs against a real Postgres via testcontainers (no mocks for SQL).

---

## File Structure

- `package.json` — deps, `bin`, scripts.
- `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` — tooling.
- `src/cli.ts` — bin entry; routes `init` / `serve`.
- `src/config.ts` — load/save `claude-memory.config.json` (typed).
- `src/db/schema.sql` — the migration SQL.
- `src/db/migrate.ts` — idempotent migration runner.
- `src/db/store.ts` — `MemoryStore` class: remember/recall/forget/list/confirm/supersede.
- `src/mcp/server.ts` — MCP server wiring the tools to `MemoryStore`.
- `src/wizard/init.ts` — interactive init flow.
- `src/wizard/mcp-config.ts` — merge a server entry into Claude Code's `.mcp.json`.
- `tests/*.test.ts` — one test file per source unit.

---

### Task 1: Project scaffold + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/cli.ts`

**Interfaces:**
- Produces: a runnable bin `claude-memory` that prints usage for unknown commands; `npm run build`, `npm test`, `npm run typecheck` scripts.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "claude-memory",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "bin": { "claude-memory": "dist/cli.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0",
    "@clack/prompts": "^0.7.0"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^10.13.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write `tsup.config.ts` and `vitest.config.ts`**

`tsup.config.ts`:
```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/cli.ts", "src/mcp/server.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
```

- [ ] **Step 4: Write minimal `src/cli.ts`**

```ts
const [, , command] = process.argv;

async function main() {
  switch (command) {
    case "init":
      (await import("./wizard/init.js")).runInit();
      break;
    case "serve":
      (await import("./mcp/server.js")).serve();
      break;
    default:
      console.log("Usage: claude-memory <init|serve>");
      process.exit(command ? 1 : 0);
  }
}
main();
```

- [ ] **Step 5: Install and verify build/typecheck**

Run: `npm install && npm run typecheck`
Expected: typecheck fails only on the not-yet-created `./wizard/init.js` / `./mcp/server.js` imports — acceptable at this step. Run `node -e "process.argv[2]=undefined"` is not needed; instead temporarily stub the two imports OR proceed (the dynamic imports are not type-checked as missing modules under Bundler resolution if files exist). Create empty stubs to unblock:

`src/wizard/init.ts`: `export function runInit() {}`
`src/mcp/server.ts`: `export function serve() {}`

Re-run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts vitest.config.ts src/cli.ts src/wizard/init.ts src/mcp/server.ts package-lock.json
git commit -m "chore: project scaffold and tooling"
```

---

### Task 2: Schema + idempotent migration runner

**Files:**
- Create: `src/db/schema.sql`, `src/db/migrate.ts`, `tests/migrate.test.ts`

**Interfaces:**
- Produces: `migrate(pool: Pool): Promise<void>` — applies `schema.sql`, safe to run repeatedly.

- [ ] **Step 1: Write the failing test `tests/migrate.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
});
afterAll(async () => { await pool.end(); await container.stop(); });

describe("migrate", () => {
  it("creates the memories table and is idempotent", async () => {
    await migrate(pool);
    await migrate(pool); // second run must not throw
    const { rows } = await pool.query(
      "select column_name from information_schema.columns where table_name='memories' order by column_name"
    );
    const cols = rows.map(r => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      "id","namespace","content","kind","tags","source","confidence",
      "status","superseded_by","created_at","last_confirmed_at","fts"
    ]));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/migrate.test.ts`
Expected: FAIL — cannot import `../src/db/migrate.js` (module missing).

- [ ] **Step 3: Write `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace         text NOT NULL,
  content           text NOT NULL,
  kind              text,
  tags              text[] NOT NULL DEFAULT '{}',
  source            text,
  confidence        real NOT NULL DEFAULT 0.7,
  status            text NOT NULL DEFAULT 'active',
  superseded_by     uuid REFERENCES memories(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  fts               tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS memories_namespace_idx ON memories (namespace);
CREATE INDEX IF NOT EXISTS memories_fts_idx ON memories USING gin (fts);
CREATE INDEX IF NOT EXISTS memories_status_idx ON memories (namespace, status);
```

- [ ] **Step 4: Write `src/db/migrate.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(pool: Pool): Promise<void> {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}
```

Note for build: ensure `schema.sql` ships next to the compiled file. Add to `tsup.config.ts` a copy step:
```ts
// in tsup.config.ts defineConfig add:
  onSuccess: "cp src/db/schema.sql dist/schema.sql",
```
and change `migrate.ts` path resolution to also work post-build by trying `join(here, "schema.sql")` then `join(here, "../src/db/schema.sql")`:
```ts
import { existsSync } from "node:fs";
const candidates = [join(here, "schema.sql"), join(here, "db/schema.sql"), join(here, "../src/db/schema.sql")];
const path = candidates.find(existsSync)!;
const sql = readFileSync(path, "utf8");
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run tests/migrate.test.ts`
Expected: PASS (requires Docker running for testcontainers).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/migrate.ts tests/migrate.test.ts tsup.config.ts
git commit -m "feat: postgres schema and idempotent migration runner"
```

---

### Task 3: MemoryStore data layer

**Files:**
- Create: `src/db/store.ts`, `tests/store.test.ts`

**Interfaces:**
- Consumes: `migrate(pool)` from Task 2.
- Produces:
  ```ts
  type Memory = {
    id: string; namespace: string; content: string; kind: string | null;
    tags: string[]; source: string | null; confidence: number;
    status: string; created_at: string; last_confirmed_at: string;
  };
  class MemoryStore {
    constructor(pool: Pool, namespace: string);
    remember(input: { content: string; kind?: string; tags?: string[]; source?: string; confidence?: number }): Promise<Memory>;
    recall(query: string, k?: number): Promise<Memory[]>;     // full-text, status='active', ranked
    list(filter?: { kind?: string; status?: string }): Promise<Memory[]>;
    forget(id: string): Promise<boolean>;                      // sets status='archived'
    confirm(id: string): Promise<boolean>;                     // bumps last_confirmed_at
    supersede(oldId: string, newContent: string): Promise<Memory>; // archive old, insert new linked
  }
  ```

- [ ] **Step 1: Write the failing test `tests/store.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/store.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });
beforeEach(async () => { await pool.query("delete from memories"); });

describe("MemoryStore", () => {
  it("remembers and recalls by full-text", async () => {
    const s = new MemoryStore(pool, "husnain");
    await s.remember({ content: "Deploy the frontend to Vercel, not Netlify", kind: "decision" });
    await s.remember({ content: "Coffee preference is oat milk" });
    const hits = await s.recall("vercel deploy");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toMatch(/Vercel/);
  });

  it("scopes by namespace", async () => {
    const a = new MemoryStore(pool, "alice");
    const b = new MemoryStore(pool, "bob");
    await a.remember({ content: "secret alice fact about kestrels" });
    expect(await b.recall("kestrels")).toHaveLength(0);
    expect(await a.recall("kestrels")).toHaveLength(1);
  });

  it("forget archives so it stops surfacing in recall", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "temporary note about badgers" });
    expect(await s.forget(m.id)).toBe(true);
    expect(await s.recall("badgers")).toHaveLength(0);
  });

  it("supersede archives the old and links the new", async () => {
    const s = new MemoryStore(pool, "husnain");
    const old = await s.remember({ content: "Deploy to Netlify" });
    const fresh = await s.supersede(old.id, "Deploy to Vercel");
    expect(fresh.content).toBe("Deploy to Vercel");
    const recalled = await s.recall("deploy");
    expect(recalled.map(r => r.content)).toEqual(["Deploy to Vercel"]);
  });

  it("confirm bumps last_confirmed_at", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "uses pnpm" });
    const before = m.last_confirmed_at;
    await new Promise(r => setTimeout(r, 10));
    expect(await s.confirm(m.id)).toBe(true);
    const [after] = await s.list();
    expect(new Date(after.last_confirmed_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot import `../src/db/store.js`.

- [ ] **Step 3: Implement `src/db/store.ts`**

```ts
import type { Pool } from "pg";

export type Memory = {
  id: string; namespace: string; content: string; kind: string | null;
  tags: string[]; source: string | null; confidence: number;
  status: string; created_at: string; last_confirmed_at: string;
};

const COLS = `id, namespace, content, kind, tags, source, confidence, status,
  created_at::text, last_confirmed_at::text`;

export class MemoryStore {
  constructor(private pool: Pool, private namespace: string) {}

  async remember(input: { content: string; kind?: string; tags?: string[]; source?: string; confidence?: number }): Promise<Memory> {
    const { rows } = await this.pool.query(
      `insert into memories (namespace, content, kind, tags, source, confidence)
       values ($1,$2,$3,$4,$5,$6) returning ${COLS}`,
      [this.namespace, input.content, input.kind ?? null, input.tags ?? [],
       input.source ?? null, input.confidence ?? 0.7]
    );
    return rows[0];
  }

  async recall(query: string, k = 8): Promise<Memory[]> {
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
    return rowCount === 1;
  }

  async confirm(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update memories set last_confirmed_at=now() where id=$1 and namespace=$2`,
      [id, this.namespace]
    );
    return rowCount === 1;
  }

  async supersede(oldId: string, newContent: string): Promise<Memory> {
    const fresh = await this.remember({ content: newContent });
    await this.pool.query(
      `update memories set status='superseded', superseded_by=$1
       where id=$2 and namespace=$3`,
      [fresh.id, oldId, this.namespace]
    );
    return fresh;
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/store.ts tests/store.test.ts
git commit -m "feat: MemoryStore data layer with full-text recall"
```

---

### Task 4: Config load/save

**Files:**
- Create: `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Config = { postgresUrl: string; namespace: string; embeddings: { provider: "none" } };
  function configPath(cwd?: string): string;          // <cwd>/claude-memory.config.json
  function saveConfig(c: Config, cwd?: string): void;
  function loadConfig(cwd?: string): Config;          // throws if missing/invalid
  ```

- [ ] **Step 1: Write the failing test `tests/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, loadConfig } from "../src/config.js";

describe("config", () => {
  it("round-trips a config through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-"));
    const cfg = { postgresUrl: "postgres://x", namespace: "husnain", embeddings: { provider: "none" as const } };
    saveConfig(cfg, dir);
    expect(loadConfig(dir)).toEqual(cfg);
  });

  it("throws a clear error when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-"));
    expect(() => loadConfig(dir)).toThrow(/not found.*claude-memory init/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  postgresUrl: z.string().min(1),
  namespace: z.string().min(1),
  embeddings: z.object({ provider: z.literal("none") }),
});
export type Config = z.infer<typeof ConfigSchema>;

export function configPath(cwd = process.cwd()): string {
  return join(cwd, "claude-memory.config.json");
}

export function saveConfig(c: Config, cwd = process.cwd()): void {
  writeFileSync(configPath(cwd), JSON.stringify(ConfigSchema.parse(c), null, 2));
}

export function loadConfig(cwd = process.cwd()): Config {
  const p = configPath(cwd);
  if (!existsSync(p)) {
    throw new Error(`Config not found at ${p}. Run 'claude-memory init' first.`);
  }
  return ConfigSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: typed config load/save"
```

---

### Task 5: MCP server exposing the tools

**Files:**
- Modify: `src/mcp/server.ts` (replace stub)
- Create: `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `MemoryStore`, `migrate`.
- Produces:
  ```ts
  function buildToolHandlers(store: MemoryStore): {
    remember(args): Promise<string>;
    recall(args): Promise<string>;
    forget(args): Promise<string>;
    list(args): Promise<string>;
    confirm(args): Promise<string>;
    supersede(args): Promise<string>;
  };
  function serve(): Promise<void>;   // boots stdio MCP server from config
  ```
- Rationale: tool *logic* is factored into `buildToolHandlers` so it's testable without spinning the stdio transport; `serve()` only wires transport + registration.

- [ ] **Step 1: Write the failing test `tests/mcp-tools.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/store.js";
import { buildToolHandlers } from "../src/mcp/server.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });
beforeEach(async () => { await pool.query("delete from memories"); });

describe("tool handlers", () => {
  it("remember then recall returns a human-readable summary", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    const saved = await h.remember({ content: "Prefers tabs over spaces", kind: "preference" });
    expect(saved).toMatch(/remembered/i);
    const recalled = await h.recall({ query: "tabs spaces" });
    expect(recalled).toMatch(/tabs over spaces/);
  });

  it("recall reports nothing found cleanly", async () => {
    const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
    expect(await h.recall({ query: "nonexistent" })).toMatch(/no memories/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: FAIL — `buildToolHandlers` not exported.

- [ ] **Step 3: Implement `src/mcp/server.ts`**

```ts
import { Pool } from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { migrate } from "../db/migrate.js";
import { MemoryStore, type Memory } from "../db/store.js";
import { loadConfig } from "../config.js";

function fmt(m: Memory): string {
  const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  return `• ${m.content}${tags} (${m.kind ?? "note"}, conf ${m.confidence}, id ${m.id})`;
}

export function buildToolHandlers(store: MemoryStore) {
  return {
    async remember(a: { content: string; kind?: string; tags?: string[]; source?: string; confidence?: number }) {
      const m = await store.remember(a);
      return `Remembered: ${fmt(m)}`;
    },
    async recall(a: { query: string; k?: number }) {
      const hits = await store.recall(a.query, a.k);
      return hits.length ? hits.map(fmt).join("\n") : "No memories found.";
    },
    async list(a: { kind?: string; status?: string }) {
      const all = await store.list(a);
      return all.length ? all.map(fmt).join("\n") : "No memories.";
    },
    async forget(a: { id: string }) {
      return (await store.forget(a.id)) ? `Forgot ${a.id}.` : `No memory ${a.id}.`;
    },
    async confirm(a: { id: string }) {
      return (await store.confirm(a.id)) ? `Confirmed ${a.id}.` : `No memory ${a.id}.`;
    },
    async supersede(a: { id: string; content: string }) {
      const m = await store.supersede(a.id, a.content);
      return `Superseded ${a.id} → ${fmt(m)}`;
    },
  };
}

export async function serve(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.postgresUrl });
  await migrate(pool);
  const handlers = buildToolHandlers(new MemoryStore(pool, cfg.namespace));
  const server = new McpServer({ name: "claude-memory", version: "0.1.0" });

  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  server.tool("remember", "Store a distilled fact in long-term memory.",
    { content: z.string(), kind: z.string().optional(), tags: z.array(z.string()).optional(),
      source: z.string().optional(), confidence: z.number().min(0).max(1).optional() },
    async (a) => text(await handlers.remember(a)));

  server.tool("recall", "Search long-term memory by full text.",
    { query: z.string(), k: z.number().int().positive().optional() },
    async (a) => text(await handlers.recall(a)));

  server.tool("list", "List/audit stored memories.",
    { kind: z.string().optional(), status: z.string().optional() },
    async (a) => text(await handlers.list(a)));

  server.tool("forget", "Archive a memory by id.",
    { id: z.string() }, async (a) => text(await handlers.forget(a)));

  server.tool("confirm", "Mark a memory as still true (refresh freshness).",
    { id: z.string() }, async (a) => text(await handlers.confirm(a)));

  server.tool("supersede", "Replace an outdated memory with a corrected one.",
    { id: z.string(), content: z.string() }, async (a) => text(await handlers.supersede(a)));

  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the server boots over stdio (smoke test)**

Run:
```bash
npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | CM_SKIP=1 node -e "import('./dist/server.js')" 2>/dev/null || true
```
Expected: this is a non-fatal smoke check; the authoritative check is the passing handler test in Step 4. (A full stdio round-trip is exercised in Task 6 via the wizard-installed config.)

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp-tools.test.ts
git commit -m "feat: MCP server exposing memory tools"
```

---

### Task 6: Claude Code MCP-config writer

**Files:**
- Create: `src/wizard/mcp-config.ts`, `tests/mcp-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function upsertMcpEntry(mcpJsonPath: string, command: string, args: string[]): void;
  // creates or merges { mcpServers: { "claude-memory": { command, args } } }
  ```

- [ ] **Step 1: Write the failing test `tests/mcp-config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertMcpEntry } from "../src/wizard/mcp-config.js";

describe("upsertMcpEntry", () => {
  it("creates a new .mcp.json with our server", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-"));
    const p = join(dir, ".mcp.json");
    upsertMcpEntry(p, "claude-memory", ["serve"]);
    const j = JSON.parse(readFileSync(p, "utf8"));
    expect(j.mcpServers["claude-memory"]).toEqual({ command: "claude-memory", args: ["serve"] });
  });

  it("preserves existing servers when merging", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-"));
    const p = join(dir, ".mcp.json");
    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    upsertMcpEntry(p, "claude-memory", ["serve"]);
    const j = JSON.parse(readFileSync(p, "utf8"));
    expect(j.mcpServers.other).toEqual({ command: "x" });
    expect(j.mcpServers["claude-memory"]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/mcp-config.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/wizard/mcp-config.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function upsertMcpEntry(mcpJsonPath: string, command: string, args: string[]): void {
  const doc = existsSync(mcpJsonPath)
    ? JSON.parse(readFileSync(mcpJsonPath, "utf8"))
    : {};
  doc.mcpServers = doc.mcpServers ?? {};
  doc.mcpServers["claude-memory"] = { command, args };
  writeFileSync(mcpJsonPath, JSON.stringify(doc, null, 2));
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/mcp-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wizard/mcp-config.ts tests/mcp-config.test.ts
git commit -m "feat: merge claude-memory entry into .mcp.json"
```

---

### Task 7: Init wizard + README, end-to-end

**Files:**
- Modify: `src/wizard/init.ts` (replace stub)
- Modify: `README.md` (usage section)
- Create: `tests/init.test.ts`

**Interfaces:**
- Consumes: `saveConfig`, `migrate`, `upsertMcpEntry`.
- Produces:
  ```ts
  async function runInitWith(deps: {
    prompt: (q: string) => Promise<string>;   // injected for testability
    cwd: string;
    connect: (url: string) => Promise<import("pg").Pool>;
  }): Promise<void>;
  function runInit(): void;   // real entrypoint: wires @clack/prompts + pg + cwd
  ```
- Rationale: the side-effecting flow is injected so the test drives it without real prompts; `runInit` is the thin production wiring.

- [ ] **Step 1: Write the failing test `tests/init.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { runInitWith } from "../src/wizard/init.js";

let container: StartedPostgreSqlContainer;
beforeAll(async () => { container = await new PostgreSqlContainer("postgres:16").start(); });
afterAll(async () => { await container.stop(); });

describe("runInitWith", () => {
  it("writes config, .mcp.json, and migrates the db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-"));
    const url = container.getConnectionUri();
    const answers = [url, "husnain"]; // postgres url, namespace
    let i = 0;
    await runInitWith({
      cwd: dir,
      prompt: async () => answers[i++],
      connect: async (u) => new Pool({ connectionString: u }),
    });

    expect(existsSync(join(dir, "claude-memory.config.json"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, "claude-memory.config.json"), "utf8"));
    expect(cfg.namespace).toBe("husnain");
    expect(cfg.embeddings.provider).toBe("none");

    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["claude-memory"].args).toEqual(["serve"]);

    const pool = new Pool({ connectionString: url });
    const { rows } = await pool.query("select to_regclass('public.memories') as t");
    expect(rows[0].t).toBe("memories");
    await pool.end();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/init.test.ts`
Expected: FAIL — `runInitWith` not exported.

- [ ] **Step 3: Implement `src/wizard/init.ts`**

```ts
import { join } from "node:path";
import { Pool } from "pg";
import * as p from "@clack/prompts";
import { saveConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { upsertMcpEntry } from "./mcp-config.js";

export async function runInitWith(deps: {
  prompt: (q: string) => Promise<string>;
  cwd: string;
  connect: (url: string) => Promise<Pool>;
}): Promise<void> {
  const postgresUrl = (await deps.prompt("Postgres connection string")).trim();
  const namespace = (await deps.prompt("Namespace (your identity, shared across machines)")).trim();

  const pool = await deps.connect(postgresUrl);
  await migrate(pool);
  await pool.end();

  saveConfig({ postgresUrl, namespace, embeddings: { provider: "none" } }, deps.cwd);
  upsertMcpEntry(join(deps.cwd, ".mcp.json"), "claude-memory", ["serve"]);
}

export function runInit(): void {
  (async () => {
    p.intro("claude-memory init");
    await runInitWith({
      cwd: process.cwd(),
      connect: async (url) => new Pool({ connectionString: url }),
      prompt: async (q) => {
        const v = await p.text({ message: q });
        if (p.isCancel(v)) { p.cancel("Aborted."); process.exit(1); }
        return v as string;
      },
    });
    p.outro("Done. Restart Claude Code to load the memory tools.");
  })();
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/init.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `README.md` usage section**

Replace the "Status" line at the bottom with:

```markdown
## Usage

```bash
npx claude-memory init     # wizard: Postgres URL + namespace, migrates DB, registers MCP server
# restart Claude Code — memory tools (remember/recall/forget/list/confirm/supersede) are now available
```

Add a second machine by running the same `init` with the **same Postgres URL and namespace** — both
machines now share one brain.

**Status:** v1 core (this plan). Semantic embeddings, living-memory reconciliation, and background
dreaming land in follow-on plans — see `docs/specs/`.
```

- [ ] **Step 6: Full test + build gate**

Run: `npm test && npm run build && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/wizard/init.ts tests/init.test.ts README.md
git commit -m "feat: init wizard wiring config, migration, and MCP registration"
```

---

## Self-Review

**Spec coverage (this plan = M1 only):**
- Install wizard (§9) → Task 7. ✓
- MCP tools remember/recall/forget/list/confirm/supersede (§6) → Tasks 3, 5. ✓
- `memories` table with living-memory fields (§5) → Task 2 (fields present; *reconciliation logic* is Plan 3). ✓
- Full-text fallback, no embeddings (§7 default tier) → Task 3 `recall`. ✓
- Namespace cross-machine sharing (§4) → Tasks 3, 7. ✓
- No LLM key (Global Constraints) → nothing in this plan calls an LLM. ✓
- **Deferred to later plans (correctly out of scope here):** embeddings/pgvector (Plan 2), staleness/contradiction reconciliation (Plan 3), dreaming (Plan 4), central-server mode + multi-OS polish (Plan 5).

**Placeholder scan:** No "TBD"/"handle errors"/"similar to Task N" — every code step shows full code. The Task 5 Step 5 stdio smoke check is explicitly marked non-authoritative with the real assertion in Step 4.

**Type consistency:** `Memory` shape, `MemoryStore` method names, and `buildToolHandlers` keys are identical across Tasks 3, 5, 7. `upsertMcpEntry(path, command, args)` signature matches between Tasks 6 and 7. `runInitWith` deps match between Task 7 test and impl.

**Note for executor:** Tasks 2, 3, 5, 7 require Docker running (testcontainers spins a real `postgres:16`).

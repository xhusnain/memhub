# memhub v2 — Unified Multi-CLI Memory + Smarter Memory: Implementation Plan

> Executed inline in this session (autonomous). No commits/pushes — the whole diff stays in the working tree for review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared Postgres brain usable by every AI CLI concurrently (Claude Code, Codex, Gemini, opencode, OpenClaw, Cursor), plus research-driven memory-quality upgrades: server-enforced dedupe, write-time reconciliation, composite retrieval ranking, temporal grounding, and a hardened dream.

**Architecture:** memhub stays a stdio MCP server spawned per CLI session, all processes sharing one Postgres — so every stateful mechanism (dedupe, dream gating, locks) lives in Postgres, never in process memory. The calling agent's LLM remains the only brain; the server adds deterministic guards (hash dedupe, ranking math, advisory locks) that work even when a weak agent ignores instructions.

**Tech Stack:** TypeScript ESM, `pg`, `@modelcontextprotocol/sdk`, `zod`, `@clack/prompts`, vitest + testcontainers. No new runtime dependencies.

## Global Constraints

- No comments anywhere in `src/` or `tests/` (user rule; already enforced on existing code).
- No commits, no pushes — working tree only.
- No rented LLM: the server never calls an LLM API; only the calling agent or the headless dream reasons.
- Backend stays plain Postgres; pgvector optional; everything degrades to FTS-only.
- Lean: no new abstractions/layers beyond one new `src/clients.ts` module; no new deps.
- All schema changes idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), safe to run on every serve start against live v0.2 data.
- Numeric heuristics (thresholds, decay) are named constants, documented here as heuristics to tune — not hidden magic.

---

## Research base (what informed this design)

Full notes in scratchpad (`notes-mem0.md`, `notes-honcho.md`, `notes-papers-core.md`, `notes-papers-temporal.md`, `notes-blogs.md`, `notes-cli-formats.md`); structured findings in `workflow-result` JSONs. Key adopted findings:

- **mem0** (repo): write-time hash dedupe against retrieved neighbors; "existing memories echo" so the extracting LLM reconciles; memory-quality prompt rules (temporal grounding, self-contained, keep specifics, transitions include old state, no meta-facts); update guardrails (more-information-wins; possibly-coexisting facts are kept, not merged); entity boost replaced their graph. OpenMemory = their multi-client MCP product (per-app provenance).
- **Honcho** (repo): Postgres-native work claiming for concurrency; dream gating discipline (threshold + min-interval); split deduction/induction passes; provenance ids on derived facts (memhub already does this).
- **Generative Agents / MemGPT / A-MEM / Mem0 papers**: composite retrieval score = relevance × recency decay × importance; importance rated by the agent at write time; reflection with evidence pointers.
- **Zep/Graphiti, HippoRAG, sleep-time compute**: event time ≠ ingestion time (`observed_at`); invalidate-don't-delete (memhub's supersede already does this); expiring transient facts; offline consolidation pays off most for predictable queries.
- **Critique flags designed around**: memhub is stdio-spawned per session → no in-process session state anywhere; dream hardcodes `claude` → configurable runner; english FTS stems code identifiers → add a `simple`-config shadow tsvector; per-CLI native memory double-store → snippet says prefer memhub; `clientInfo.name` unverified → primary client identity via `MEMHUB_CLIENT` env baked into each registration, clientInfo only as fallback.

**Verified CLI integration matrix** (each verified against official docs AND the live install on this machine):

| CLI | Register via | Config target | Instructions file |
|---|---|---|---|
| Claude Code | `claude mcp remove` + `claude mcp add --scope user --env MEMHUB_CLIENT=claude memhub -- memhub serve` | `~/.claude.json` (CLI-managed) | `~/.claude/CLAUDE.md` |
| Codex CLI | `codex mcp remove memhub` + `codex mcp add memhub --env MEMHUB_CLIENT=codex -- memhub serve` | `~/.codex/config.toml` (CLI-managed) | `~/.codex/AGENTS.md` |
| Gemini CLI | direct JSON merge (CLI's default scope is project — footgun) | `~/.gemini/settings.json` → `mcpServers.memhub = {command,args,env}` | `~/.gemini/GEMINI.md` |
| opencode | direct JSON merge (`opencode mcp add` is interactive-only) | `~/.config/opencode/opencode.json` → `mcp.memhub = {type:"local",command:["memhub","serve"],enabled,environment}` | `~/.config/opencode/AGENTS.md` |
| OpenClaw | direct JSON merge (installed 2026.3.12 has no `mcp` subcommand; config shape is the documented forward format) | `~/.openclaw/openclaw.json` → `mcp.servers.memhub = {command,args}` | `~/.openclaw/workspace/AGENTS.md` |
| Cursor | direct JSON merge (no add command exists) | `~/.cursor/mcp.json` → `mcpServers.memhub = {command,args,env}` | none |

## Design decisions (and rejected alternatives)

1. **Server-side dedupe via a generated hash column, not agent compliance.** `content_hash` is `GENERATED ALWAYS AS (md5(lower(regexp_replace(btrim(content), '\s+', ' ', 'g')))) STORED` — normalization lives in exactly one place (SQL), and a partial unique index on `(namespace, content_hash) WHERE status='active'` makes duplicate saves impossible even from non-compliant agents. A duplicate `remember` silently becomes a `confirm` (freshness bump) — strictly better than an error. *Rejected:* Node-side hashing (two normalizers to keep in sync); pgcrypto sha256 (extension dependency; md5 is built-in and collision resistance is irrelevant here).
2. **Insert-then-reconcile, not propose-then-insert.** `remember` always inserts first, then returns up to 3 similar existing memories with the instruction to `supersede`/`confirm`/`forget`. mem0/Zep do LLM reconciliation *before* insert; with weak agents that loses memories when the follow-up never comes. Insert-first means memory is never lost and reconciliation is a bonus. *Rejected:* two-phase `needs_reconciliation` handshake (compliance-dependent, flagged by research critique).
3. **Composite ranking with bounded multiplicative boosts.** `score = rrf × (0.7 + 0.3·e^(−ageDays/90)) × (0.75 + 0.5·salience)`. Bounds keep relevance dominant (recency can only halve-ish, salience swing ±25%): an old, low-salience but exactly-matching fact still wins over a fresh vague one. *Rejected:* mem0's adaptive-sigmoid additive fusion (more knobs, needs a benchmark harness to tune honestly — harness is follow-up work).
4. **Three retrieval lists in RRF: pgvector + english FTS + simple FTS.** The `simple` config doesn't stem, so `GeoIPHub`, `feeds.json`, `pg_advisory_lock` match literally — critical for coding-CLI content. *Rejected:* lemmatized shadow-text column (needs an external lemmatizer).
5. **Client identity via `MEMHUB_CLIENT` env baked into each registration; `clientInfo.name` fallback.** Deterministic where we control the config; degrades to whatever the MCP handshake reports; provenance-only (no security use). *Rejected:* OpenMemory-style app registry + ACL + pause switch (real infra, contradicts lean; provenance column gives 80% of the value).
6. **Registration = CLI command where verified stable (claude, codex), direct JSON merge elsewhere.** JSON merge refuses to touch files that fail `JSON.parse` (never clobber a config we can't read). *Rejected:* TOML editing for codex (would need a TOML dep; `codex mcp add` is verified).
7. **Dream v2 = advisory lock + embedding-based near-dup candidates + guardrail prompt + configurable runner.** `pg_try_advisory_lock` makes N concurrent serve/dream processes safe across machines and CLIs. Near-dup pairs (embedding distance < 0.15) are computed by SQL for free and fed to the dream as candidates. `dreamCommand` config overrides the hardcoded `claude` (e.g. `["codex","exec","--full-auto"]`; prompt appended as last arg). *Rejected:* MCP sampling to borrow the client's LLM (client support still sparse).
8. **Short-id ergonomics instead of integer remapping.** Display ids as 8-char prefixes; every id-taking tool resolves unique prefixes. Stateless (works with per-session stdio processes), and mem0's anti-hallucination worry shrinks with 8 hex chars vs UUIDs. *Rejected:* per-session integer maps (requires session state the architecture doesn't have).
9. **Temporal fields: `observed_at` + `expires_at` only.** Event-time provenance and transient-fact expiry (filtered at recall) capture most of Zep's bi-temporal value; full `valid_at`/`invalid_at` invalidation stays out (supersede chains already cover it). Namespace/project scoping stays as-is (global identity) — noted as future work.
10. **`context` tool for one-call session bootstrap.** Peer-card + top-salience + most-recent in one call; weak agents don't need to craft recall queries to benefit. *(MemGPT core-memory analog.)*

## File structure

- Create: `src/clients.ts` (adapters, detection, JSON merge, registration), `tests/clients.test.ts`
- Modify: `src/db/schema.ts`, `src/db/store.ts`, `src/mcp/server.ts`, `src/dream.ts`, `src/config.ts`, `src/wizard/init.ts`, `src/wizard/capture-snippet.ts`, `src/cli.ts` (no change expected), `README.md`, `package.json` (version 0.3.0)
- Delete: `src/wizard/register-mcp.ts`, `tests/register-mcp.test.ts` (folded into clients)
- Extend tests: `tests/store.test.ts`, `tests/migrate.test.ts`, `tests/dream.test.ts`, `tests/mcp-tools.test.ts`, `tests/init.test.ts`, `tests/capture-snippet.test.ts`, `tests/config.test.ts`

---

### Task 1: Schema v2

**Files:** Modify `src/db/schema.ts`; test `tests/migrate.test.ts`.

**Produces:** columns `content_hash` (generated), `salience real default 0.5`, `client text`, `observed_at timestamptz`, `expires_at timestamptz`, `access_count int default 0`, `last_accessed_at timestamptz`, `fts_simple tsvector` (generated, gin-indexed); partial unique index `memories_active_hash_idx (namespace, content_hash) WHERE status='active'`, preceded in the same script by an archive-duplicates statement so the index always creates cleanly on legacy data.

- [ ] Append to `SCHEMA_SQL` (order matters — dedupe before unique index):

```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash text
  GENERATED ALWAYS AS (md5(lower(regexp_replace(btrim(content), '\s+', ' ', 'g')))) STORED;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS salience real NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS client text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS observed_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count int NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS fts_simple tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
CREATE INDEX IF NOT EXISTS memories_fts_simple_idx ON memories USING gin (fts_simple);
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY namespace, content_hash
    ORDER BY last_confirmed_at DESC, created_at DESC
  ) AS rn FROM memories WHERE status = 'active'
)
UPDATE memories m SET status = 'archived' FROM ranked r WHERE m.id = r.id AND r.rn > 1;
CREATE UNIQUE INDEX IF NOT EXISTS memories_active_hash_idx
  ON memories (namespace, content_hash) WHERE status = 'active';
```

- [ ] Tests (`migrate.test.ts`): migrate twice on same DB (idempotent); seed two active rows whose contents differ only in whitespace/case on a v1-shaped table, migrate, expect one active + one archived and the unique index present.
- [ ] Run `npx vitest run tests/migrate.test.ts` — expect fail before schema change, pass after.

### Task 2: Store v2 — remember with dedupe + similar echo, new fields

**Files:** Modify `src/db/store.ts`; test `tests/store.test.ts`.

**Produces (consumed by Tasks 4/6):**
- `type Memory` gains `salience: number; client: string | null; observed_at: string | null; expires_at: string | null; access_count: number`.
- `remember(input)` accepts `salience?, observedAt?, expiresAt?` and returns `{ memory: Memory; deduped: boolean; similar: Similar[] }` where `Similar = Memory & { distance: number | null }`.
- `MemoryStore` constructor gains optional `client?: () => string | null`.

- [ ] Extend `COL_LIST` with `salience`, `client`, `observed_at::text`, `expires_at::text`, `access_count`.
- [ ] `insertMemory` uses `ON CONFLICT (namespace, content_hash) WHERE status = 'active' DO NOTHING RETURNING ...`; zero rows ⇒ select the existing active row by the same md5 expression over `$content`, `confirm` it, return `{deduped: true}`.
- [ ] `similar`: when a fresh embedder vector exists, top 3 active others by `embedding <=> $vec` with distance ≤ `SIMILAR_MAX_DISTANCE = 0.5`; else top 3 by `ts_rank(fts, plainto_tsquery('english', $content))` where matching. Exclude the new row.
- [ ] `supersede(oldId, content)` handles the new-content-already-exists case: conflict ⇒ reuse the existing active row as the successor; if that row IS `oldId`, just confirm (no self-supersede).
- [ ] Tests: same content twice ⇒ second is `deduped:true`, one active row, freshness bumped; whitespace/case variant also dedupes; `similar` returned for a near-match (FTS path, no embedder); supersede-to-existing-content reuses the row; supersede-to-same-content no-ops.

### Task 3: Store v2 — ranked recall, prefix ids, context, access tracking

**Files:** Modify `src/db/store.ts`; test `tests/store.test.ts`.

**Produces (consumed by Task 6):**
- `recall(query, k=8)` — 3-list RRF (vector + english + simple FTS), overfetch `max(3k, 24)`, expiry filter, final score `rrf × recency × salience` (constants `RECENCY_FLOOR=0.7`, `RECENCY_HALF_DAYS=90`, `SALIENCE_FLOOR=0.75`), bumps `access_count`/`last_accessed_at` on returned rows.
- `resolveId(idOrPrefix)` — 36-char passthrough; else unique-prefix lookup (min 6 chars), throws on ambiguous/unknown. Used by `forget`/`confirm`/`supersede`/`history`.
- `context()` — `{ peerCard: Memory | null; top: Memory[]; recent: Memory[] }` (top 12 by SQL `salience × recency` expression excluding peer-card, 5 most recent, deduplicated).

- [ ] All recall/list/context queries filter `(expires_at IS NULL OR expires_at > now())` (list only when `status='active'` filter is in play — keep `list` able to audit expired rows via explicit status).
- [ ] Tests: identifier query (`"feeds.json"`) found via simple-FTS list; higher-salience beats lower on equal text match; expired row absent from recall but present in `list({status:'active'})` is false / audit path documented; access_count increments; 8-char prefix resolves, 4-char throws, ambiguous throws; context returns peer-card + salient rows without duplicates.

### Task 4: Clients module (multi-CLI registration)

**Files:** Create `src/clients.ts`, `tests/clients.test.ts`; delete `src/wizard/register-mcp.ts`, `tests/register-mcp.test.ts`.

**Produces (consumed by Task 5/6):**
```ts
export type ClientKey = "claude" | "codex" | "gemini" | "opencode" | "openclaw" | "cursor";
export type Run = (file: string, args: string[]) => void;
export type Which = (bin: string) => boolean;
export type ClientAdapter = {
  key: ClientKey;
  title: string;
  bin: string;
  configDir(home: string): string;
  instructionsFile(home: string): string | null;
  register(home: string, run: Run): void;
};
export const CLIENTS: ClientAdapter[];
export function detectClients(home: string, which?: Which): ClientKey[];
export function registerClient(key: ClientKey, home: string, run?: Run): void;
```

- [ ] `jsonMergeFile(path, mutate)` helper: missing file ⇒ `{}`; unparseable ⇒ throw `"<path> exists but is not valid JSON — fix it and re-run memhub init"`; writes 2-space JSON + trailing newline, `mkdir -p` parent.
- [ ] Adapters exactly per the verified matrix above (env `MEMHUB_CLIENT` everywhere we control the file or the command supports `--env`; OpenClaw gets no env key — format doesn't document one — clientInfo fallback covers it).
- [ ] claude/codex adapters: remove-then-add via injected `run`, remove failures swallowed.
- [ ] Tests (temp `home` dirs, fake `run` recording calls, fake `which`): each JSON adapter writes the exact expected shape into an empty home; merging preserves unrelated existing keys; malformed JSON throws and leaves file untouched; claude/codex emit exact command sequences; `detectClients` picks up dirs and bins.

### Task 5: Snippet v2 + wizard multi-client step + config fields

**Files:** Modify `src/wizard/capture-snippet.ts`, `src/wizard/init.ts`, `src/config.ts`; tests `tests/capture-snippet.test.ts`, `tests/init.test.ts`, `tests/config.test.ts`.

**Produces:** `Config` gains `clients: string[]` (default `["claude"]`) and `dreamCommand?: string[]`; `InitIO` gains `multiselect`; init registers every chosen client and installs the snippet into each client's instructions file (auto mode).

- [ ] New SNIPPET text (same markers, so old blocks upgrade in place): context-at-start, recall-before-remember, reconcile the `similar` echo, absolute dates / self-contained / keep specifics / transitions with old state, salience + observed_at/expires_at guidance, prefer memhub over built-in per-CLI memory, never save secrets.
- [ ] `init` flow: after embeddings step — `detectClients`, `io.multiselect` (detected preselected, claude always on), register each chosen (per-client try/catch: one broken CLI must not abort the others; report per-client ✓/✗), then `applyCaptureSnippet(instructionsFile, mode)` for each chosen client with a non-null instructions file. "Keep & re-apply" re-registers `config.clients`.
- [ ] Tests: config round-trips new fields and defaults `clients` when absent (legacy config compat); init with fake IO registers chosen clients + writes snippet to each instructions file; manual mode strips from all.

### Task 6: MCP server v2 — tool surface

**Files:** Modify `src/mcp/server.ts`; test `tests/mcp-tools.test.ts`.

- [ ] `remember` inputSchema adds `salience` (0..1), `observed_at` (ISO string), `expires_at` (ISO string); handler response: normal ⇒ `Remembered: …` plus, when `similar` non-empty, `Similar existing memories — if any states the same fact, supersede/confirm it instead of keeping both:` + formatted list; dedupe ⇒ `Already known (confirmed instead): …`.
- [ ] New `context` tool (no args): peer-card section + `Key memories` + `Recent` sections; description says to call once at session start.
- [ ] `fmt` shows `sal`, `client`, `observed` (when set) and 8-char ids; descriptions for id-taking tools mention short ids.
- [ ] `serve()` passes `client` closure: `process.env.MEMHUB_CLIENT ?? server.server.getClientVersion()?.name ?? null`.
- [ ] Tool descriptions rewritten with the mem0-derived quality rules (compact, ~10 lines on `remember`).
- [ ] Tests extend the handler-level suite: remember echoes similar; dedupe message; context assembles sections; short-id accepted by confirm/forget handlers.

### Task 7: Dream v2

**Files:** Modify `src/dream.ts`; test `tests/dream.test.ts`.

- [ ] `runDreamWith`: `pg_try_advisory_lock(hashtext('memhub:'||namespace))` after connect; not acquired ⇒ log + return `{deduped: 0, skipped: true}`; unlock in `finally`.
- [ ] Near-dup candidate feed: same-provider/model/dim embedding pairs with distance < `NEAR_DUP_DISTANCE = 0.15` (limit 20), joined to contents, appended to the prompt as reconciliation candidates with short ids; wrapped in try/catch (no embeddings table ⇒ skip silently).
- [ ] `buildDreamPrompt(candidates?)` gains guardrail rules: more-information-wins; possibly-coexisting facts are kept as separate facts (never merged on suspicion); no meta-facts; rewrite relative dates to absolute using created_at; short ids acceptable in tool calls.
- [ ] Runner: `cfg.dreamCommand` (from Task 5) overrides the default claude invocation — `execFileSync(cmd[0], [...cmd.slice(1), prompt])`; default unchanged.
- [ ] Tests: second concurrent `runDreamWith` (separate pool) skips while first holds the lock; prompt contains the new rules and candidate block when pairs exist; custom `dreamCommand` receives the prompt as last arg.

### Task 8: README + version + docs

**Files:** Modify `README.md`, `package.json`.

- [ ] README: multi-CLI setup matrix (the verified table), new tool table (`context`, remember fields), ranking explanation (one paragraph), temporal fields, dreamCommand, concurrency note (advisory lock; safe with N CLIs × M machines). Version → `0.3.0`.

### Task 9: Full verification

- [ ] `npm run typecheck` clean; `npm test` fully green (Docker present).
- [ ] `grep -rn "//\|/\*" src/ tests/` shows only regex literals/URLs — no comments.
- [ ] Smoke: `node dist/cli.js` usage after `npm run build`; `memhub serve` handshake against the real config left untouched (do NOT run init against the live home dir — adapters are exercised via tests with temp homes only).
- [ ] Adversarial multi-agent review of `git diff`; fix confirmed findings; re-run suite.

## Follow-ups deliberately out of scope (v2.1 candidates)

- Retrieval benchmark harness (LongMemEval-style probes) to tune constants honestly — prerequisite for swapping RRF for additive fusion.
- Entity index table + query-time entity boost (mem0's LLM-free graph replacement).
- Project-scope namespaces derived from MCP roots/cwd.
- Streamable-HTTP central mode with auth.

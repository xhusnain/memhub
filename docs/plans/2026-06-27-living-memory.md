# Living Memory (Plan 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make memory self-maintaining: surface stale facts, let confidence accumulate with re-confirmation, give the agent a `review` tool to find memories needing attention, and prime the agent (in auto mode) to reconcile contradictions and stale facts during normal work.

**Architecture:** The store already carries the living-memory fields (`confidence`, `status`, `superseded_by`, `last_confirmed_at`). This plan adds the *operations and signals* that turn those fields into self-healing behavior: a `stale()` query, a confidence-bumping `confirm`, a `review` MCP tool, freshness shown in tool output, and reconciliation guidance in the auto-capture instruction block. The intelligence stays with Claude (it decides what's contradicted/outdated); this plan gives it the primitives and the prompting to act.

**Tech Stack:** Same as prior milestones — Node ≥20, TypeScript (ESM, strict), `pg`, `zod`, `@modelcontextprotocol/sdk`, `vitest` + `@testcontainers/postgresql`, `tsup`.

## Global Constraints

- Node ≥ 20, ESM, TypeScript strict.
- No required LLM key (this plan adds no provider calls — reconciliation intelligence is Claude itself).
- All store queries namespace-scoped (carry-over invariant).
- `stale()` considers only `status='active'` memories (archived/superseded are not "stale", they're done).
- Confidence is a `real` in [0,1]; `confirm` raises it but caps at 1.0.
- Existing tool output format must stay parseable by existing tests (the id-extraction regex `id <uuid>)` must still match after fmt changes).
- The reconciliation guidance is installed only via the **auto-capture** snippet (global `~/.claude/CLAUDE.md`), consistent with M3b; manual mode is unchanged.
- DB-touching tests run against real Postgres via testcontainers.
- Package/bin name: `claude-memory`. MIT.

---

## File Structure

- Modify: `src/db/store.ts` — add `stale()`; `confirm` bumps confidence.
- Modify: `tests/store.test.ts` — stale + confidence tests.
- Modify: `src/mcp/server.ts` — `review` handler + tool; freshness in `fmt`.
- Modify: `tests/mcp-tools.test.ts` — review tool test.
- Modify: `src/wizard/capture-snippet.ts` — reconciliation guidance in SNIPPET.
- Modify: `tests/capture-snippet.test.ts` — assert guidance present.

---

### Task 1: Store primitives — `stale()` + confidence-bumping `confirm`

**Files:**
- Modify: `src/db/store.ts`
- Modify: `tests/store.test.ts`

**Interfaces:**
- Produces (added/changed on `MemoryStore`):
  ```ts
  stale(olderThanDays: number, limit?: number): Promise<Memory[]>; // active, last_confirmed_at older than N days, oldest first
  confirm(id: string): Promise<boolean>; // now also raises confidence by 0.1 capped at 1.0, plus refreshes last_confirmed_at
  ```

- [ ] **Step 1: Add the failing tests to `tests/store.test.ts`**

Append a new describe block (this file already starts a real Postgres container in `beforeAll` and wipes `memories` in `beforeEach`):

```ts
describe("MemoryStore living-memory primitives", () => {
  it("confirm refreshes timestamp and raises confidence, capped at 1.0", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "uses pnpm" });
    expect(m.confidence).toBeCloseTo(0.7, 5);
    await s.confirm(m.id);
    const [after] = await s.list();
    expect(after.confidence).toBeCloseTo(0.8, 4);
    for (let i = 0; i < 5; i++) await s.confirm(m.id); // drive past 1.0
    const [capped] = await s.list();
    expect(capped.confidence).toBeLessThanOrEqual(1.0001);
    expect(capped.confidence).toBeGreaterThan(0.99);
  });

  it("stale() returns active memories not confirmed within N days, oldest first", async () => {
    const s = new MemoryStore(pool, "husnain");
    const old = await s.remember({ content: "old fact about kestrels" });
    await s.remember({ content: "fresh fact about otters" });
    await pool.query("update memories set last_confirmed_at = now() - interval '10 days' where id=$1", [old.id]);
    const stale = await s.stale(7);
    expect(stale.map((r) => r.content)).toContain("old fact about kestrels");
    expect(stale.map((r) => r.content)).not.toContain("fresh fact about otters");
  });

  it("stale() excludes archived/superseded memories", async () => {
    const s = new MemoryStore(pool, "husnain");
    const m = await s.remember({ content: "archived stale thing" });
    await pool.query("update memories set last_confirmed_at = now() - interval '30 days' where id=$1", [m.id]);
    await s.forget(m.id);
    expect((await s.stale(7)).map((r) => r.content)).not.toContain("archived stale thing");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `s.stale` is not a function / confidence not bumped by `confirm`.

- [ ] **Step 3: Update `src/db/store.ts`**

Replace the `confirm` method with the confidence-bumping version, and add the `stale` method (place it near `list`). Use the existing `COLS` constant.

```ts
async confirm(id: string): Promise<boolean> {
  const { rowCount } = await this.pool.query(
    `update memories
     set last_confirmed_at = now(),
         confidence = least(1.0, confidence + 0.1)
     where id=$1 and namespace=$2`,
    [id, this.namespace]
  );
  return (rowCount ?? 0) === 1;
}

async stale(olderThanDays: number, limit = 20): Promise<Memory[]> {
  const { rows } = await this.pool.query(
    `select ${COLS} from memories
     where namespace=$1 and status='active'
       and last_confirmed_at < now() - make_interval(days => $2::int)
     order by last_confirmed_at asc
     limit $3`,
    [this.namespace, olderThanDays, limit]
  );
  return rows;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (existing store tests plus the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/db/store.ts tests/store.test.ts
git commit -m "feat: stale() query and confidence-accruing confirm"
```

---

### Task 2: `review` MCP tool + freshness in output

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `MemoryStore.stale` (Task 1).
- Produces: `buildToolHandlers(store)` gains a `review(a: { days?: number; k?: number }): Promise<string>` handler; a `review` tool registered in `serve()`; `fmt` now includes the last-confirmed date.

- [ ] **Step 1: Add the failing test to `tests/mcp-tools.test.ts`**

Append (this file wipes `memories` in `beforeEach` and builds handlers against the real container):

```ts
it("review surfaces stale memories and reports none cleanly", async () => {
  const h = buildToolHandlers(new MemoryStore(pool, "husnain"));
  const saved = await h.remember({ content: "Stale config note" });
  const id = saved.match(/id ([0-9a-f-]{36})/)![1];
  await pool.query("update memories set last_confirmed_at = now() - interval '60 days' where id=$1", [id]);

  expect(await h.review({ days: 30 })).toMatch(/Stale config note/);
  expect(await h.review({ days: 90 })).toMatch(/no stale memories/i);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: FAIL — `h.review` is not a function.

- [ ] **Step 3: Update `src/mcp/server.ts`**

(a) Enhance `fmt` to show the last-confirmed date (keep `conf` and the `id <uuid>)` tail intact so existing regexes still match):

```ts
function fmt(m: Memory): string {
  const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  return `• ${m.content}${tags} (${m.kind ?? "note"}, conf ${m.confidence}, confirmed ${m.last_confirmed_at.slice(0, 10)}, id ${m.id})`;
}
```

(b) Add the `review` handler inside `buildToolHandlers`:

```ts
    async review(a: { days?: number; k?: number }) {
      const hits = await store.stale(a.days ?? 30, a.k);
      return hits.length ? hits.map(fmt).join("\n") : "No stale memories.";
    },
```

(c) Register the tool in `serve()` (match the existing `registerTool(name, { description, inputSchema }, cb)` shape used by the other tools):

```ts
  server.registerTool("review", {
    description: "List memories not confirmed recently that may be stale. Review each and confirm, supersede, or forget it to keep memory honest.",
    inputSchema: { days: z.number().int().positive().optional(), k: z.number().int().positive().optional() },
  }, async (a) => text(await handlers.review(a)));
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: PASS (existing tool tests, with the unchanged `id`-extraction regex still matching, plus the new review test).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp-tools.test.ts
git commit -m "feat: review tool for stale memories; show last-confirmed in output"
```

---

### Task 3: Reconciliation guidance in the auto-capture snippet

**Files:**
- Modify: `src/wizard/capture-snippet.ts`
- Modify: `tests/capture-snippet.test.ts`

**Interfaces:**
- No signature change. The managed `SNIPPET` block (installed in auto mode) gains reconciliation guidance so Claude actively keeps memory honest during sessions. Idempotency/preservation behavior is unchanged.

- [ ] **Step 1: Add the failing assertion to `tests/capture-snippet.test.ts`**

Append a test (the existing tests cover markers/idempotency/preservation):

```ts
it("auto block includes reconciliation guidance", () => {
  const p = join(mkdtempSync(join(tmpdir(), "cm-")), "CLAUDE.md");
  applyCaptureSnippet(p, "auto");
  const text = readFileSync(p, "utf8");
  expect(text).toMatch(/supersede/i);
  expect(text).toMatch(/confirm/i);
  expect(text).toMatch(/review/i);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/capture-snippet.test.ts`
Expected: FAIL — the current SNIPPET mentions remember/supersede/forget but not `confirm`/`review` reconciliation guidance (the `review` assertion fails).

- [ ] **Step 3: Update the `SNIPPET` constant in `src/wizard/capture-snippet.ts`**

Replace the `SNIPPET` constant with this expanded version (keep the existing markers and all other logic unchanged):

```ts
const SNIPPET = `## Long-term memory (claude-memory)

Proactively maintain long-term memory using the claude-memory MCP tools, without being asked:
- Call \`remember\` when you learn a durable fact about the user, their projects, preferences, decisions, or environment. Record where it came from (source).
- Keep memory honest as you work:
  - When the user contradicts a remembered fact or it is out of date, use \`supersede\` to replace it or \`forget\` to remove it.
  - When a memory you rely on still holds, \`confirm\` it so its freshness and confidence stay current.
  - Use \`review\` to surface stale memories and reconcile each one.
- Keep memories concise and factual. Never save secrets or transient details.
- At the start of relevant work, \`recall\` what you already know.`;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/capture-snippet.test.ts`
Expected: PASS (all existing snippet tests plus the new guidance test).

- [ ] **Step 5: Full gate**

Run: `npm test && npm run build && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wizard/capture-snippet.ts tests/capture-snippet.test.ts
git commit -m "feat: reconciliation guidance in auto-capture instructions"
```

---

## Self-Review

**Spec coverage (Plan 3 / M3 living memory):**
- Staleness surfacing → Task 1 `stale()` + Task 2 `review` tool + freshness in `fmt`. ✓
- Confidence as a living signal (accrues with re-confirmation) → Task 1 `confirm` bump (capped). ✓
- Contradiction reconciliation → existing `supersede`/`forget` + Task 3 guidance directing their use. ✓
- Provenance → existing `source` field + Task 3 guidance to record it. ✓
- Self-healing behavior (the agent acts during sessions) → Task 3 snippet guidance (auto mode). ✓
- No new LLM dependency (Claude is the reconciliation brain) → nothing in this plan calls a provider. ✓
- Namespace-scoped → Task 1 `stale()` filters `namespace`. ✓
- Deferred (correctly out of scope): unattended background reconciliation = Plan 4 (Dreaming) drives these same primitives on a schedule; automatic confidence *decay* over time (kept simple — staleness is time-based via `stale()`, confidence changes only on explicit confirm).

**Placeholder scan:** every code step shows full code; no TBD/"handle errors"/"similar to".

**Type consistency:** `stale(olderThanDays, limit?)` and the confidence-bumping `confirm` match between Task 1 (impl) and Task 2 (consumer via `store.stale`); `review(a)` handler shape matches the `registerTool` inputSchema; `fmt` change preserves the `id <uuid>)` tail and `conf` token relied on by existing `tests/mcp-tools.test.ts` and `tests/store.test.ts` regexes.

**Note for executor:** Tasks 1 and 2 require Docker (testcontainers). `tests/store.test.ts` currently uses `pgvector/pgvector:pg16`; the new living-memory tests don't need pgvector but share that container — fine. Existing tool-output assertions must keep passing after the `fmt` change; the `id`-extraction regex `id ([0-9a-f-]{36})` still matches because the `id <uuid>)` tail is preserved.

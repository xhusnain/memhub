# Public Polish + Publish Prep (Plan 5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `claude-memory` publish-ready: redact the Postgres URL from any error output, add npm metadata + a LICENSE + a `prepublishOnly` build, and refresh the README to accurately document the now-complete feature set.

**Architecture:** A tiny `redactUrl` helper sanitizes connection strings out of error messages, applied at every error-logging site (the init wizard and the dream command). `package.json` gains publish metadata and a `prepublishOnly` hook so `dist/` is always fresh. The README is rewritten to reflect all shipped capabilities (cross-machine sync, auto/manual capture, semantic embeddings, living memory, dreaming) — removing the stale "coming soon" markers.

**Tech Stack:** Same as prior milestones — Node ≥20, TypeScript (ESM, strict), `vitest`. No new runtime deps.

## Global Constraints

- Node ≥ 20, ESM, TypeScript strict.
- The Postgres URL (which contains credentials) must never appear in printed error output.
- No behavioral change to the memory engine — this milestone is hardening + metadata + docs only.
- `npm pack` must include only `dist/`, `README.md`, `LICENSE`, and `package.json` (no `src/`, `tests/`, `docs/`, `.superpowers/`).
- Package/bin name: `claude-memory`. License: MIT.
- The repository URL in `package.json` is a placeholder to be confirmed before an actual `npm publish` (no git remote exists yet) — use `https://github.com/husnain/claude-memory`.

---

## File Structure

- Create: `src/redact.ts` — `redactUrl(text)`.
- Create: `tests/redact.test.ts`.
- Modify: `src/wizard/init.ts` — redact in the `runInit` catch.
- Modify: `src/dream.ts` — redact in the `runDream` catch and the semantic-skip log.
- Modify: `package.json` — metadata + `prepublishOnly`.
- Create: `LICENSE` — MIT.
- Modify: `README.md` — full refresh.

---

### Task 1: `redactUrl` helper + apply at error sites

**Files:**
- Create: `src/redact.ts`, `tests/redact.test.ts`
- Modify: `src/wizard/init.ts`, `src/dream.ts`

**Interfaces:**
- Produces: `function redactUrl(text: string): string;` — replaces any `postgres://…` / `postgresql://…` substring with `postgres://***redacted***`.

- [ ] **Step 1: Write the failing test `tests/redact.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { redactUrl } from "../src/redact.js";

describe("redactUrl", () => {
  it("redacts a postgres connection string with credentials", () => {
    const msg = "connect ECONNREFUSED postgres://user:s3cret@db.example.com:5432/app";
    const out = redactUrl(msg);
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("user:");
    expect(out).toContain("postgres://***redacted***");
  });

  it("redacts the postgresql:// scheme too", () => {
    expect(redactUrl("bad url postgresql://a:b@h/d")).toContain("postgres://***redacted***");
  });

  it("leaves messages without a connection string unchanged", () => {
    expect(redactUrl("model not found: text-embedding-3-small")).toBe("model not found: text-embedding-3-small");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/redact.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/redact.ts`**

```ts
// Replace any postgres/postgresql connection string with a safe placeholder so
// credentials never reach logs or error output.
export function redactUrl(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://***redacted***");
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/redact.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply redaction at the error sites**

In `src/wizard/init.ts`, import the helper and wrap the catch message:
```ts
import { redactUrl } from "../redact.js";
// ...in runInit's .catch:
  })().catch((err) => {
    p.cancel(`Error: ${redactUrl(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  });
```

In `src/dream.ts`, import the helper and wrap both the `runDream` catch and the semantic-skip log:
```ts
import { redactUrl } from "./redact.js";
// semantic-skip log:
      deps.log?.(`Semantic pass skipped (claude unavailable): ${redactUrl(e instanceof Error ? e.message : String(e))}`);
// runDream catch:
  }).catch((err) => {
    console.error(`dream failed: ${redactUrl(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  });
```

- [ ] **Step 6: Verify the full suite still passes**

Run: `npm test && npm run typecheck`
Expected: all PASS (existing init/dream tests unaffected; redaction is transparent for non-URL messages).

- [ ] **Step 7: Commit**

```bash
git add src/redact.ts tests/redact.test.ts src/wizard/init.ts src/dream.ts
git commit -m "fix: redact postgres url from error output"
```

---

### Task 2: npm metadata + LICENSE + prepublishOnly

**Files:**
- Modify: `package.json`
- Create: `LICENSE`

**Interfaces:**
- No code interface. Produces publish-ready package metadata.

- [ ] **Step 1: Update `package.json`**

Add publish metadata and a `prepublishOnly` script. The full file should become:

```json
{
  "name": "claude-memory",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "description": "Smart, self-maintaining, cross-machine memory for Claude Code — Postgres-backed, no rented LLM brain.",
  "keywords": ["claude", "claude-code", "mcp", "memory", "postgres", "pgvector", "embeddings", "ai", "agent"],
  "author": "Husnain",
  "homepage": "https://github.com/husnain/claude-memory#readme",
  "repository": { "type": "git", "url": "https://github.com/husnain/claude-memory.git" },
  "bugs": { "url": "https://github.com/husnain/claude-memory/issues" },
  "bin": { "claude-memory": "dist/cli.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "npm run build"
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

- [ ] **Step 2: Create `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Husnain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Verify the packaged contents**

Run: `npm run build && npm pack --dry-run`
Expected: the listed files are only under `dist/`, plus `README.md`, `LICENSE`, and `package.json`. Confirm `src/`, `tests/`, `docs/`, and `.superpowers/` are NOT listed. (`files: ["dist"]` plus npm's always-included README/LICENSE/package.json guarantees this.)

- [ ] **Step 4: Confirm metadata is valid**

Run: `node -e "const p=require('./package.json'); console.log(p.description, '|', p.keywords.join(','), '|', p.repository.url)"`
Expected: prints the description, keywords, and repo URL with no error.

- [ ] **Step 5: Commit**

```bash
git add package.json LICENSE
git commit -m "chore: npm publish metadata, MIT LICENSE, prepublishOnly build"
```

---

### Task 3: README full refresh

**Files:**
- Modify: `README.md`

**Interfaces:**
- No code. Produces an accurate, complete README.

- [ ] **Step 1: Rewrite `README.md`**

Replace the entire file with the following (accurate to the shipped feature set — no "coming soon" markers):

````markdown
# claude-memory

> Smart, self-maintaining, cross-machine memory for Claude Code — Postgres-backed, no rented LLM brain.

mem0 and Honcho are memory stores that pay a separate LLM (OpenAI) to do the thinking. **claude-memory**
flips that: in Claude Code the LLM is already in the room, so Claude does the extraction, reasoning, and
background reconciliation itself — for free. The backend is just **Postgres**.

```bash
npx claude-memory init
```

## What you get

- **Follows you across machines** — every machine points at one shared Postgres, so office / home / laptop
  share a single brain. Postgres *is* the sync.
- **Works in every project** — registered at user scope, so the memory tools are available everywhere, not
  per-repo.
- **Automatic or manual capture** — choose `auto` (Claude saves and updates memories silently as you work,
  no commands) or `manual` (only when you ask). Manual `remember`/`forget` work in both modes.
- **Semantic recall** — optional embeddings (OpenAI or local **Ollama**, no key required) give vector search
  blended with full-text via Reciprocal Rank Fusion. Without embeddings it falls back to Postgres full-text —
  it works with *just* a Postgres URL.
- **Self-healing (living memory)** — every fact tracks source, confidence, and freshness. Confidence grows as
  facts are re-confirmed; the `review` tool surfaces stale memories; contradictions get superseded.
- **Background dreaming** — `claude-memory dream` archives duplicates and runs a headless Claude pass to
  reconcile stale/contradictory memories. Schedule it with cron.
- **Yours** — plain rows in your own Postgres, no opaque vendor store, no required LLM API key.

## Setup

```bash
npx claude-memory init     # global setup, then restart Claude Code
```

The wizard asks for:
- **Postgres connection string** (Supabase / Neon / Railway / self-hosted all work).
- **Namespace** — your identity; the same namespace on another machine shares one brain.
- **Capture mode** — `auto` (recommended) or `manual`.
- **Embeddings provider** — `none` (full-text only), `openai`, or `ollama`.

It migrates the schema, registers the MCP server at user scope, and (in `auto` mode) installs a small
instruction block into `~/.claude/CLAUDE.md`.

Add another machine by running the same `init` with the **same Postgres URL, namespace, and capture mode**.

## Memory tools (used by Claude)

| Tool | Purpose |
|---|---|
| `remember` | Store a distilled fact (content, kind, tags, source, confidence). |
| `recall` | Hybrid full-text + vector search. |
| `review` | List stale memories to reconcile. |
| `confirm` | Mark a fact still true (refreshes freshness, raises confidence). |
| `supersede` | Replace an outdated fact with a corrected one. |
| `forget` | Archive a fact. |
| `list` | Browse / audit memories. |

In `auto` mode Claude calls these proactively; you can also just say "remember this" / "forget that".

## Dreaming (background maintenance)

```bash
claude-memory dream                # run a maintenance pass now
claude-memory dream --print-cron   # print a crontab line to schedule it
```

The pass archives exact-duplicate memories, then launches a headless Claude pass (`claude -p`) that reviews
and reconciles stale/contradictory memories. The semantic pass needs the `claude` CLI logged in on the
machine running the job; if it's unavailable the duplicate cleanup still runs and the semantic step is
logged and skipped.

## Requirements

- Node ≥ 20.
- A Postgres database. For semantic embeddings, Postgres with the `pgvector` extension (Supabase / Neon
  provide it; self-hosted needs `CREATE EXTENSION vector`, done automatically when you enable a provider).

## License

MIT
````

- [ ] **Step 2: Full gate**

Run: `npm test && npm run build && npm run typecheck`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: full README refresh for the complete feature set"
```

---

## Self-Review

**Spec coverage (Plan 5):**
- Postgres URL never in error output → Task 1 `redactUrl` applied at the init + dream error sites. ✓
- npm publish metadata + LICENSE + prepublishOnly → Task 2. ✓
- `npm pack` ships only dist + README + LICENSE + package.json → Task 2 Step 3 (`files: ["dist"]`). ✓
- Accurate README (no stale "coming soon") → Task 3. ✓
- No engine behavior change → only redaction (transparent), metadata, docs. ✓

**Placeholder scan:** every code/file step shows full content; the only intentional placeholder is the repository URL (documented as needing confirmation before publish).

**Type consistency:** `redactUrl(text: string): string` consistent across `redact.ts`, its test, and the two call sites (init.ts, dream.ts).

**Note for executor:** Task 1 changes only error-message formatting, so existing init/dream tests (which assert on success paths and the dedupe count) are unaffected; run the full suite to confirm. The repository URL placeholder must be updated once a real GitHub remote exists.

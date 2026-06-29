# Claude Living Memory — Design

**Status:** Draft for review
**Date:** 2026-06-27
**Working name:** `claude-memory` (package / CLI). Final name TBD.

---

## 1. One-paragraph summary

A public, open-source npx package that gives Claude Code a **smart, self-maintaining, cross-machine memory** — without renting an LLM brain. The user runs one command (`npx claude-memory init`), points it at a Postgres database, and optionally picks an embedding provider. From then on, Claude Code remembers what matters across every session and every machine, recalls it semantically, keeps it honest (flags stale/contradicted facts), and improves it in the background ("dreaming"). The key insight: **the LLM is already in the room.** mem0 and Honcho are dumb stores that pay OpenAI to do the thinking; here Claude does the extraction, reasoning, and dreaming for free, so the backend is just Postgres.

## 2. The core insight (why this is different)

```
mem0 / Honcho:   [ store ] + [ rented OpenAI brain ]   → needs an LLM API key, server, workers
claude-memory:   [ store ] + [ Claude, already here ]  → brain is free; backend is just Postgres
```

Honcho's praised "smart memory" (inferring unstated facts, background "dreaming") is **not special infrastructure — it is an LLM doing inference.** Claude is an equally capable LLM, already invoked on every session. So we reproduce the smartness and remove the rented brain.

## 3. Goals / Non-goals

### Goals
- **One-command install** (`npx claude-memory init`) — DX modeled on `loop-init`.
- **No LLM API key required.** Claude is the brain.
- **Cross-machine by default** — all machines connect to one shared Postgres; Postgres *is* the sync.
- **Cross-tool friendly** — anything that speaks MCP can use it (Claude Code first; Cursor/others later).
- **Living memory** — every fact tracks source, confidence, and freshness; the system self-heals.
- **Semantic recall** with pluggable embedding providers (OpenAI / Ollama / Cloudflare / Gemini / Voyage), embeddings **optional** (full-text fallback).
- **Background dreaming** — scheduled headless-Claude consolidation pass.
- **Transparent & user-owned** — memories are inspectable/editable rows; export to markdown.

### Non-goals (v1)
- Not a hosted SaaS. Users bring their own Postgres.
- Not a general RAG/document store. It stores *distilled memories*, not arbitrary corpora.
- No built-in multi-tenant billing/auth beyond a connection string + namespace.
- We do **not** "save every message." We save curated facts (raw archive is opt-in).

## 4. Architecture

```
┌─ Machine A (office) ─┐   ┌─ Machine B (home) ─┐   ┌─ Machine C (laptop) ─┐
│ Claude Code          │   │ Claude Code        │   │ Claude Code          │
│   └─ MCP client      │   │   └─ MCP client    │   │   └─ MCP client      │
└──────────┬───────────┘   └─────────┬──────────┘   └──────────┬───────────┘
           │                          │                          │
           └──────────────┬───────────┴──────────────┬───────────┘
                          ▼                            ▼
                 ┌───────────────────┐      (writes during sessions)
                 │  claude-memory     │
                 │  MCP server        │  ← the npx package (Node)
                 │  remember/recall/  │
                 │  forget/list       │
                 └─────────┬──────────┘
                           ▼
                 ┌───────────────────────────────┐
                 │  Postgres (shared, BYO)        │  ← single brain / sync point
                 │  memories | embeddings | raw   │
                 └───────────────────────────────┘
                           ▲
                 ┌─────────┴──────────┐
                 │ dream (cron/loop)  │  ← headless `claude -p` consolidation
                 └────────────────────┘
```

Two ways the MCP server runs (user choice at init):
- **Local-per-machine:** each machine runs its own MCP server process, all pointing at the same shared Postgres (e.g. Supabase/Neon/Railway/self-hosted). Simplest; no exposed service.
- **Central:** one MCP server (HTTP/SSE) on an always-on box that all machines connect to. Fewer moving parts client-side, but the server must be secured/exposed.

Recommended default: **local-per-machine + shared managed Postgres.** Nothing to expose except Postgres (which managed providers already secure).

## 5. Data model

```sql
-- one row per distilled fact
memories (
  id            uuid pk,
  namespace     text not null,        -- user/team/project scope, e.g. "husnain" or "team:geoiphub"
  content       text not null,        -- the fact, in natural language
  kind          text,                 -- preference | project | reference | person | decision ...
  tags          text[],
  source        text,                 -- provenance: "chat 2026-06-27", file, commit, etc.
  confidence    real default 0.7,     -- 0..1, set by Claude
  status        text default 'active',-- active | stale | superseded | archived
  superseded_by uuid references memories(id),
  created_at    timestamptz default now(),
  last_confirmed_at timestamptz default now(),
  fts           tsvector generated   -- full-text index (always present)
)

-- optional, only if embeddings enabled
memory_embeddings (
  memory_id  uuid references memories(id) on delete cascade,
  provider   text,                    -- openai | ollama | cloudflare | ...
  model      text,
  dim        int,
  embedding  vector                   -- pgvector; dim matches provider
)

-- optional raw archive (off by default)
raw_archive (
  id uuid pk, namespace text, session_ref text, content text, created_at timestamptz
)
```

**Living-memory fields** (`source`, `confidence`, `status`, `last_confirmed_at`, `superseded_by`) are the moat: they power staleness flagging, contradiction reconciliation, and provenance — things mem0/Honcho's MCP layers don't expose.

## 6. MCP tools (the interface Claude Code uses)

| Tool | Purpose |
|---|---|
| `remember(content, kind?, tags?, source?, confidence?)` | Store a distilled fact. Server embeds it if embeddings enabled. |
| `recall(query, k?, namespace?)` | Hybrid search: full-text + (if enabled) vector similarity, ranked. Returns facts with metadata. |
| `forget(id \| query)` | Delete or mark archived. Supports "never remember X" patterns. |
| `list(filter?)` | Browse/audit memories (by kind, tag, status, age). |
| `confirm(id)` / `supersede(old_id, new_content)` | Used during reconciliation to refresh or replace facts. |

Claude (not the server) decides *what* to remember, *how* to phrase it, *when* to reconcile. The server is mechanical: store, embed, search, return.

## 6b. Capture modes — auto + manual (both always available)

Honcho is fully automatic: the developer only calls `add_messages` + `chat`; the Deriver decides what to keep. We match that **and** keep transparent manual control, because the brain (Claude) already reads every message in the session — unlike Honcho, we don't have to ship messages to a rented LLM for a background worker to read them.

- **Auto-capture (the Honcho experience):** Claude silently calls `remember` / `supersede` / `forget` during normal work — the user issues **no commands**. This is driven by a behavioral instruction the package installs (an `AGENTS.md` / `CLAUDE.md` snippet + the MCP tool descriptions) that primes Claude to distill durable facts as a side-effect of the session. This is the same instinct Claude Code's built-in memory already uses, pointed at the shared Postgres.
- **Manual:** the user can still explicitly say "remember this" / "forget that," and Claude calls the same tools. Manual works whether or not auto is on.

**The wizard lets the user choose** (see §9): `auto` (default — recommended, feels like Honcho) or `manual-only` (Claude only saves when explicitly asked). The choice is stored in the **global** config and can be flipped later. Even in `auto` mode, manual `remember`/`forget` remain available — auto and manual are not mutually exclusive.

| | Honcho | claude-memory |
|---|---|---|
| Ingest | `add_messages` → auto-derive (server ships msgs to OpenAI) | Claude auto-calls `remember` (already sees the messages) |
| Query | `chat` | `recall` |
| Background reconcile | Deriver + "dream" | `dream` command on cron |
| Manual override | `create_observations` / `delete` (optional) | `remember` / `forget` (optional, always on) |

## 6c. Global, not per-project (scope)

Memory follows the **user**, not a repo — so configuration and MCP registration live at **global / user scope**, not per-project:

- **Config** lives in the user's home (e.g. `~/.claude-memory/config.json`), NOT `<cwd>/claude-memory.config.json`. One config per user/machine; every project on that machine shares the same brain.
- **MCP registration** is at **user scope** (Claude Code's user config, e.g. `claude mcp add --scope user` / `~/.claude.json`), NOT a project-local `.mcp.json`. The memory tools are then available in **every** project automatically.
- The `auto`/`manual` capture setting and the chosen namespace are global too, so behavior is consistent across all projects on that machine.

> **Note — revises M1:** Plan 1 (already built) wrote a project-level `claude-memory.config.json` and merged into a project `.mcp.json`. That must be migrated to the global locations above. Tracked as the first task of the capture-modes milestone (§12, M3b).

## 7. Embedding adapters (pluggable, optional)

- Interface: `embed(texts: string[]) -> number[][]` + declared `dim`.
- Built-in adapters: **OpenAI**, **Ollama** (local Llama / nomic-embed-text), **Cloudflare Workers AI**, **Gemini**, **Voyage**. Easy to add more.
- `dim` is recorded per row so mixed/upgraded providers don't corrupt search.
- **Fallback when no provider configured:** Postgres full-text search only. The package is fully functional with *zero* embedding setup — semantic recall is an upgrade, not a gate.

## 8. Dreaming (background consolidation)

`claude-memory dream` runs a **headless Claude** (`claude -p`) pass that:
1. Re-reads recent + sampled-old memories.
2. Derives new cross-memory insights (the Honcho "inferred fact" behavior).
3. Detects contradictions/staleness; marks `stale`/`superseded`; bumps `confidence`.
4. De-duplicates and consolidates.

**Dreaming is the *work*; the schedule is just the *trigger*.** The `dream` command is the Honcho-Deriver equivalent (powered by Claude, not OpenAI). It is woken by a scheduler — best to worst:
1. **A cron job** on one always-on machine — `0 3 * * * claude -p "run claude-memory dream"`. Truest match to Honcho's background worker (runs whether or not you're working). **Recommended.**
2. **`/schedule`** (cloud cron routines) — runs server-side even when your laptop is off.
3. **`/loop`** — weakest: only runs while a Claude Code session is open. Fine as a trigger, but not real background work.

**Caveat:** dreaming needs Claude auth available where the scheduler runs (one always-on machine or cloud). Documented as a prerequisite; the package degrades gracefully without it (memory still works, just doesn't self-improve unattended).

## 9. Install flow (`npx claude-memory init`)

Installs at **global / user scope** (see §6c) — one setup serves every project on the machine.

1. Prompt for **Postgres connection string** (offer Supabase/Neon/Railway quickstart links).
2. Run schema migration (idempotent).
3. Prompt for **namespace** (personal vs team) — this is how machines/teammates share one brain.
4. Prompt for **capture mode**: `auto` (default — Claude saves silently, the Honcho experience) or `manual-only` (saves only when explicitly asked). Either way manual `remember`/`forget` stay available. (§6b)
5. Prompt for **embedding provider** (`none` / openai / ollama / cloudflare / gemini / voyage) → store config + creds in the **global** config (`~/.claude-memory/config.json`).
6. Register the **MCP server at user scope** (`claude mcp add --scope user` / user config) so the memory tools appear in **every** project. Install the auto-capture behavioral snippet if `auto` was chosen.
7. Optionally scaffold the **dream schedule** (cron snippet; cloud `/schedule` as alternative).
8. Print next steps + how to add a second machine (same connection string + namespace + capture mode).

## 10. Security & privacy

- Secrets (DB URL, embedding keys) stored in a local config file, never committed.
- Namespacing isolates personal vs team vs project memory; recall is namespace-scoped.
- Central-server mode requires an auth token + TLS; `init` warns and helps configure.
- "Forget" and "never remember" are first-class (deletion + denylist patterns) for GDPR-style control.
- Raw archive is **off by default**; distilled facts only.

## 11. Testing strategy

- **Adapters:** contract tests per embedding provider (mock HTTP), dim correctness, fallback-to-FTS path.
- **MCP server:** integration tests against an ephemeral Postgres (testcontainers) — remember/recall/forget/supersede round-trips, hybrid ranking, namespace isolation.
- **Migrations:** idempotency + upgrade tests.
- **Dreaming:** golden-transcript tests — given a memory set + a headless-Claude stub, assert correct stale/supersede/dedup transitions.
- **Install wizard:** snapshot tests on generated config (MCP entry, cron snippet).

## 12. Roadmap (build order)

Per the chosen "everything at once" scope, v1 is broad but staged internally:

- **M1 — Core store:** schema, MCP server, `remember`/`recall`/`forget`/`list`, full-text search, namespaces, install wizard. (Usable, shareable.)
- **M2 — Semantic:** pgvector + embedding adapters (OpenAI/Ollama/Cloudflare/Gemini/Voyage), hybrid ranking.
- **M3 — Living memory:** confidence/staleness/provenance fields wired into reconciliation; `confirm`/`supersede`.
- **M3b — Global scope + capture modes:** migrate config + MCP registration from project-level (as M1 shipped) to **global/user scope** (§6c); add the wizard `auto`/`manual` capture choice and the auto-capture behavioral snippet (§6b). Keep manual tools always available.
- **M4 — Dreaming:** `dream` command (headless Claude), scheduler scaffolding (cron primary; `/schedule` cloud; `/loop` optional).
- **M5 — Polish for public release:** docs, error handling, multi-OS, Cursor/other MCP clients, examples.

## 13. Open questions

1. **Package name** — `claude-memory` is taken-risk; alternatives: `mnema`, `recall`, `living-memory`, `claude-recall`. Decide before publish.
2. ~~**Repo**~~ — DECIDED: standalone repo at `/home/hubextech/projects/husnain/claude-memory`.
3. **Central-server mode** — ship in v1 or defer? (Leaning: ship local-per-machine first, central as v1.1.)
4. **Dream identity** — does dreaming write as a distinct "agent" namespace or into the user's? (Affects provenance.)
5. ~~**Language**~~ — DECIDED: Node/TypeScript.
6. ~~**Scope**~~ — DECIDED: **global/user scope**, not per-project (§6c). M1 shipped project-level; M3b migrates it.
7. ~~**Capture**~~ — DECIDED: **both auto + manual**, wizard-selectable, default `auto`; manual always available (§6b).

## 14. Why this beats mem0 / Honcho for this use case

| | mem0 | Honcho | claude-memory |
|---|---|---|---|
| Needs rented LLM key | Yes (default) | Yes (mandatory) | **No** |
| Backend | Server + vector DB | 4 services (API/worker/PG/Redis) | **Just Postgres** |
| Smart inference | Limited | Strong | **Strong (Claude)** |
| Background dreaming | No | Yes (paid) | **Yes (free, via loop)** |
| Embeddings required | Yes | Yes | **Optional** |
| Living/trust layer | No | Partial | **Yes** |
| Transparent/editable | Vectors | Vectors | **Readable rows + md export** |
| Install | moderate | substantial | **one npx command** |
| License | Apache-2.0 | AGPL-3.0 | TBD (MIT/Apache preferred for adoption) |

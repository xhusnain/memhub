# memhub

> Smart, self-maintaining, cross-machine memory for every AI CLI — Postgres-backed, no rented LLM brain.

mem0 and Honcho are memory stores that pay a separate LLM (OpenAI) to do the thinking. **memhub**
flips that: your AI CLI's LLM is already in the room, so it does the extraction, reasoning, and
background reconciliation itself — for free. The backend is just **Postgres**, and one memory is
shared by **all** your AI CLIs on **all** your machines.

```bash
npm install -g memhub
memhub init
```

## What you get

- **One brain for every CLI** — `memhub init` detects and registers with Claude Code, Codex CLI,
  Gemini CLI, opencode, OpenClaw, and Cursor. All of them read and write the same memory,
  concurrently and safely (Postgres is the arbiter; the nightly dream takes an advisory lock).
- **Follows you across machines** — every machine points at one shared Postgres. Postgres *is* the sync.
- **Works in every project** — registered at user scope, so the memory tools are available everywhere.
- **Automatic or manual capture** — `auto` (the CLI saves and reconciles silently as you work) or
  `manual` (only when you ask). Manual `remember`/`forget` work in both modes.
- **Duplicate-proof by construction** — a normalized content hash with a partial unique index makes
  duplicate saves impossible at the database level; a duplicate `remember` becomes a `confirm`
  (freshness + confidence bump) instead. No agent discipline required.
- **Write-time reconciliation** — every `remember` echoes the most similar existing memories back to
  the calling agent with instructions to `supersede`/`confirm` instead of hoarding near-duplicates.
- **Smart recall** — hybrid retrieval (pgvector semantic + english full-text + `simple` full-text for
  code identifiers like `feeds.json`) fused with Reciprocal Rank Fusion, then ranked by
  relevance × recency decay × salience. Works with *just* a Postgres URL (full-text only).
- **Session context in one call** — the `context` tool returns the peer-card identity summary plus
  the most salient and recent facts; weak agents don't need to craft recall queries.
- **Temporal honesty** — `observed_at` records when a fact was true (not when it was saved),
  `expires_at` auto-hides transient facts, and supersede chains preserve full history.
- **Self-healing (living memory)** — every fact tracks source, source client, confidence, salience,
  and freshness. Confidence grows on re-confirmation; `review` surfaces stale memories;
  contradictions get superseded.
- **Background dreaming** — a Honcho-style reasoning pass derives new facts (deductions + inductions),
  resolves contradictions, reconciles embedding-detected near-duplicates, and maintains a stable
  **peer-card** — powered by your own CLI's LLM, no rented model.
- **Yours** — plain rows in your own Postgres, no opaque vendor store, no required LLM API key.

## Setup

```bash
npm install -g memhub
memhub init     # global setup, then restart your AI CLIs
```

The wizard asks for:
- **Postgres connection string** (Supabase / Neon / Railway / self-hosted all work).
- **Namespace** — your identity; the same namespace on another machine shares one brain.
- **Capture mode** — `auto` (recommended) or `manual`.
- **Embeddings provider** — `none` (full-text only), `openai`, `ollama`, or `cloudflare`.
- **AI CLIs to register** — installed CLIs are auto-detected and preselected.

It migrates the schema, registers the MCP server with each chosen CLI, and (in `auto` mode) installs
a small instruction block into each CLI's global instructions file.

Add another machine by running the same `init` with the **same Postgres URL, namespace, and capture
mode**. When upgrading from v0.2.x, update memhub on **all** machines — old versions error instead
of deduplicating when saving a fact that already exists.

### How each CLI is wired

| CLI | Registration | Instructions file |
|---|---|---|
| Claude Code | `claude mcp add --scope user` | `~/.claude/CLAUDE.md` |
| Codex CLI | `codex mcp add` | `~/.codex/AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` (merged) | `~/.gemini/GEMINI.md` |
| opencode | `~/.config/opencode/opencode.json` (merged) | `~/.config/opencode/AGENTS.md` |
| OpenClaw | `~/.openclaw/openclaw.json` (merged) | `~/.openclaw/workspace/AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` (merged) | — |

JSON configs are merged, never clobbered — a malformed existing file aborts that client with a clear
message. Deselecting a client on a later `init` de-registers it and removes its instruction block.
Each registration sets `MEMHUB_CLIENT` so every memory records which CLI wrote it (`list` can filter
by client) — except OpenClaw, whose config format doesn't document an env field, so its writes are
attributed via the MCP handshake instead. OpenClaw's native MCP registry requires a recent release;
the config entry is written in the documented format either way.

> **Note:** Switching embedding provider or model does **not** re-embed existing memories — older
> memories remain searchable via full-text until they are saved again.

## Memory tools (used by the CLI's agent)

| Tool | Purpose |
|---|---|
| `context` | One-call session bootstrap: peer-card + most salient + most recent facts. |
| `remember` | Store a distilled fact (content, kind, tags, source, confidence, salience, observed_at, expires_at). Dedupes by content hash; echoes similar existing memories for reconciliation. |
| `recall` | Hybrid search ranked by relevance × recency × salience. |
| `review` | List stale memories to reconcile. |
| `confirm` | Mark a fact still true (refreshes freshness, raises confidence). |
| `supersede` | Replace an outdated fact with a corrected one (reuses an existing row if the correction already exists). |
| `forget` | Archive a fact. |
| `list` | Browse / audit memories, optionally by kind, status, or source client. |
| `history` | Show how a fact evolved (its superseded versions). |

All id-taking tools accept full UUIDs or unique 8-character short ids.

In `auto` mode the agent recalls before remembering, reconciles the similar-memories echo, and calls
these tools proactively; you can also just say "remember this" / "forget that".

## How ranking works

Candidates come from up to three retrieval lists — pgvector cosine (if embeddings are enabled),
`english` full-text, and `simple` full-text (unstemmed, so identifiers and stopword-looking tokens
match literally). Lists are fused with Reciprocal Rank Fusion, then each candidate's score is
multiplied by a bounded recency decay (floor 0.7, half-life ~90 days on `last_confirmed_at`) and a
bounded salience boost (0.75–1.25). Relevance stays dominant: an old, exactly-matching fact still
beats a fresh vague one. Expired facts (`expires_at` in the past) never surface. Recalled memories
get `access_count`/`last_accessed_at` bumps for future tuning.

## Dreaming (background maintenance)

```bash
memhub dream                # run a maintenance pass now
memhub schedule             # print the right scheduler for your OS
memhub schedule --install   # install it (nightly at 03:00)
```

The dream is a **Honcho-style reasoning pass** over your distilled facts, guarded by a Postgres
advisory lock so concurrent CLIs and machines never dream twice. (Advisory locks are session-scoped:
point `postgresUrl` at a direct or session-pooled connection, not a transaction-pooling proxy like
PgBouncer transaction mode, or the lock cannot provide mutual exclusion.) It launches a headless agent
(`claude -p` by default, scoped to **only** the memhub tools) that:

- **Deduces** new facts — logical implications of what you've stated.
- **Induces** patterns — tendencies spanning ≥ 2 facts, with confidence by evidence count.
- **Resolves contradictions** — supersedes outdated or conflicting facts, keeping the version with
  more information and never merging facts that could both be true.
- **Reconciles near-duplicates** — pairs detected by embedding distance are fed in as candidates.
- **Maintains a peer-card** — a compact, stable identity summary.

Every memory carries a `level` (`explicit` = what you stated, `deductive`, or `inductive`); derived
facts record their source memory ids, and only `explicit` facts count toward the auto-trigger so the
dream can't feed on its own output.

**Automatic behavior:** in `auto` capture mode, when `memhub serve` starts and a dream is due
(≥ 6h since the last one and ≥ 5 new explicit facts), it spawns `memhub dream` as a detached
background process. In `manual` mode nothing runs on its own.

**Custom dream runner:** if the machine running the dream doesn't have `claude`, set `dreamCommand`
in `~/.memhub/config.json` (the prompt is appended as the last argument):

```json
{ "dreamCommand": ["codex", "exec", "--full-auto"] }
```

## Requirements

- Node ≥ 20.
- A Postgres database. For semantic embeddings, Postgres with the `pgvector` extension (Supabase /
  Neon provide it; self-hosted needs `CREATE EXTENSION vector`, done automatically when you enable
  a provider).

## License

MIT

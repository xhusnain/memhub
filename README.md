# memhub

> A personal memory for every AI CLI that learns how you work without being asked — Postgres-backed, no rented LLM brain.

```bash
npx memhub init
```

That one command is the whole setup. Choose **Quick** and it asks nothing else: it creates a small
database on your machine, connects the AI CLIs it finds, and turns on automatic recall and
learning. Restart your AI CLI and work as usual.

mem0 and Honcho are memory stores that pay a separate LLM (OpenAI) to do the thinking. **memhub**
flips that: your AI CLI's LLM is already in the room, so it does the extraction, reasoning, and
background reconciliation itself — for free. The backend is just **Postgres** — a local one memhub
runs for you, or your own, in which case one memory is shared by **all** your AI CLIs on **all**
your machines.

## What you get

- **One brain for every CLI** — `memhub init` detects and registers with Claude Code, Codex CLI,
  Gemini CLI, opencode, OpenClaw, and Cursor. All of them read and write the same memory,
  concurrently and safely (Postgres is the arbiter; the nightly dream takes an advisory lock).
- **Follows you across machines** — every machine points at one shared Postgres. Postgres *is* the sync.
- **Works in every project** — registered at user scope, so the memory tools are available everywhere.
- **Memory you never have to ask for** — in `auto` mode, hooks load what matters at session start,
  inject the few memories relevant to each request, and run a **reflection** over the finished
  session to learn your preferences and corrections. `manual` mode saves only when you ask.
- **Changing your mind is remembered, not overwritten** — when a preference changes, recall returns
  the current value together with what it replaced: `red background [was: "yellow background" until
  2026-11-12 — red looks better]`.
- **Project scope** — a memory is `global` (how you work everywhere) or belongs to one project;
  other projects' memories are demoted in recall and left out of session context.
- **Connected memories** — memories can be linked; recall follows links one step, so related facts
  surface together even when the query does not mention them.
- **Human-like forgetting** — every memory has a strength that grows when it is recalled or
  confirmed. Long-unused, low-importance memories fade out of active recall and come back when
  something reminds you of them. Nothing is deleted.
- **Flat token cost** — everything injected is budgeted, so a year of memories costs the same per
  session as a week of them.
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
npx memhub init          # interactive
npx memhub init --yes    # no questions: quick setup with the defaults
```

You need Node 20 or newer. Nothing else — no database, no account, no API key.

### Quick or Custom

**Quick** (recommended) uses these defaults and asks nothing:

| Setting | Quick default |
|---|---|
| Database | on this machine (memhub downloads and runs its own Postgres) |
| Namespace | your username |
| Capture | automatic |
| Search | full-text (no embeddings, no API key) |
| AI CLIs | Claude Code, plus every other supported CLI found on the machine |

**Custom** lets you choose each of these. Run `memhub init` again at any time to change them;
current values are pre-filled.

### Where memory is stored

| | On this machine | Your own Postgres |
|---|---|---|
| Setup | none | paste a connection string (Supabase / Neon / Railway / self-hosted) |
| First run | downloads Postgres once, about 130 MB (330 MB on disk) | nothing to download |
| Other machines | memory stays on this machine | same URL and namespace on each machine shares one memory |
| Semantic search (embeddings) | not available | available with the `pgvector` extension |
| Runs as | a background service on `127.0.0.1` that starts by itself when memhub needs it | whatever you host |

The local database lives in `~/.memhub/pgdata`, accepts connections from your machine only, and
has a random password stored in `~/.memhub/config.json` (readable by you alone). Manage it with
`memhub db start | stop | status`. It is available on macOS and Linux (x64 and arm64); on other
systems use your own Postgres.

To use your own database without the wizard: `npx memhub init --yes --url postgres://…`.

Two things to know about a hosted database:

- **Use a direct connection, not a transaction pooler.** The background passes take session locks,
  which PgBouncer in transaction mode does not keep. On Neon you can paste either connection
  string: memhub switches the pooled one (`-pooler` in the host) to the direct one and tells you.
- **Pick a region near you.** Each hook opens its own connection, so the network round trip to the
  database is paid on every request. A database on another continent adds about 3 seconds per
  request; a nearby region or the local database adds a fraction of that.

### What setup changes on your machine

- `~/.memhub/` — config, and the local database if you chose it.
- The `memhub` command, installed with `npm install -g memhub` if it is not already there (setup
  asks first). Your AI CLIs start memhub through this command. If npm's global folder is not on
  your `PATH`, setup registers the command's full path instead and says so.
- Each chosen AI CLI: a `memhub` MCP server entry and, in automatic mode, an instruction block in
  its global instructions file. Claude Code also gets four hooks in `~/.claude/settings.json`.

Existing settings are merged, never overwritten — a malformed config file stops that one CLI with
a clear message. Deselecting a CLI on a later `init` removes everything memhub added for it.

### Check it

```bash
memhub doctor
```

```
✓ Config found — namespace "sam", auto capture, local database
✓ memhub command is installed
✓ Database reachable — 0 active memories (0 stored in total)
✓ Claude Code: memory hooks installed
✓ Claude Code: instructions present
✓ Background learning can run (claude found)
✓ 0 session(s) waiting to be learned from

Everything is set up.
```

Every problem it finds comes with the command that fixes it. Run it whenever memory seems quiet:
the hooks never interrupt your work, so a broken setup fails silently and `doctor` is how you see
it.

### Another machine, or an upgrade

With your own Postgres, add a machine by running `init` there with the **same URL, namespace, and
capture mode**. After upgrading memhub, run `memhub init` and choose **Keep & re-apply** on each
machine; the database schema upgrades itself in place. When upgrading from v0.2.x, update **all**
machines — old versions error instead of deduplicating when saving a fact that already exists.

### How each CLI is wired

| CLI | Registration | Instructions file |
|---|---|---|
| Claude Code | `claude mcp add --scope user` | `~/.claude/CLAUDE.md` |
| Codex CLI | `codex mcp add` | `~/.codex/AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` (merged) | `~/.gemini/GEMINI.md` |
| opencode | `~/.config/opencode/opencode.json` (merged) | `~/.config/opencode/AGENTS.md` |
| OpenClaw | `~/.openclaw/openclaw.json` (merged) | `~/.openclaw/workspace/AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` (merged) | — |

Each registration sets `MEMHUB_CLIENT` so every memory records which CLI wrote it (`list` can filter
by client) — except OpenClaw, whose config format doesn't document an env field, so its writes are
attributed via the MCP handshake instead. OpenClaw's native MCP registry requires a recent release;
the config entry is written in the documented format either way.

> **Note:** Switching embedding provider or model does **not** re-embed existing memories — older
> memories remain searchable via full-text until they are saved again.

## How it behaves like memory (auto mode)

| Moment | What happens | Cost |
|---|---|---|
| Session starts | `SessionStart` hook injects your profile card and the key memories for this project. | about 650 tokens at most |
| You send a request | `UserPromptSubmit` hook searches memory with the request and injects at most 3 hits — or nothing when no memory clears the relevance gate. | about 260 tokens at most, usually 0 |
| Session ends or compacts | `SessionEnd` / `PreCompact` hook queues the transcript locally and returns at once. | none |
| Shortly after | **Reflection**: a headless run of your own CLI reads the session and files away preferences, corrections, decisions, and one short episode summary. | one background run |
| Nightly | **Dream**: consolidation, linking, contradiction repair, fading, profile card. | one background run |

The relevance gate is what keeps injection honest. Each word a memory shares with the request
scores by how rare it is across your memories (IDF), and the total must reach a fixed bar: roughly
one word found in under 1% of memories, or two words each found in under 10%. Sharing a common
word like "project" is never enough, and in a small memory one shared word is not enough either.
With embeddings on, a semantically close memory also passes. Episode summaries and the profile
card are never injected per request. Injecting nothing is the normal case.

**Reflection** works by predict-and-calibrate: it is shown what memory already knows about the
session's topics and stores only what deviates from or extends that. For each candidate it must
choose one of `confirm` (already known), `supersede` (your position changed and both cannot be
true), `remember` + `link` (both true), or nothing. Doing nothing is the preferred outcome. What you
said outright is stored as trusted; what was inferred from a single correction is stored as
tentative (confidence below 0.5) and is not auto-injected until a later session confirms it.
Trivial sessions (fewer than two user turns) are skipped without running anything.

**Strength and fading.** Retention is `exp(-days_idle / (60 × strength))`. Strength starts at 1
and rises by 1 each time a memory is recalled or confirmed (at most once per hour, capped at 10),
so things you keep using stay sharp and one-off details decay. During the dream, memories with
retention below 0.05, salience below 0.7, and age over 30 days become `faded`: out of normal
recall, still stored. A recall that finds nothing active searches faded memories too and revives
what it returns; `recall` with `deep: true` always does.

Hooks are installed for Claude Code. Other CLIs use the instruction block, which asks the agent to
call `context` and `recall` itself and to save corrections as they happen; `memhub hook <event>
--json` emits the `additionalContext` format if you want to wire another CLI's hooks by hand.

## Looking at your memory

```bash
memhub doctor                     # is everything wired correctly?
memhub stats                      # counts by status, kind, scope; sessions waiting for reflection
memhub list --kind preference     # browse (also --status faded|superseded|archived, --scope, --limit, --offset)
memhub recall remotion video      # search exactly as the agent does (add --deep for faded)
memhub history 1a2b3c4d           # how one memory changed, and what it is linked to
memhub reflect                    # process queued sessions now
```

## Memory tools (used by the CLI's agent)

| Tool | Purpose |
|---|---|
| `context` | One-call session bootstrap: peer-card + most salient + most recent facts. |
| `remember` | Store a distilled fact (content, kind, scope, tags, source, confidence, salience, links, observed_at, expires_at). Dedupes by content hash; echoes similar existing memories for reconciliation. |
| `recall` | Hybrid search plus one-step link expansion, ranked by relevance × retention × salience × project. Shows `[was: …]` for changed values. `deep` includes faded memories. |
| `review` | List stale memories to reconcile. |
| `confirm` | Mark a fact still true (refreshes freshness, raises confidence). |
| `supersede` | Replace a fact whose value changed, with a `reason`. The old version stays as history; links carry over. |
| `link` | Connect two memories that are both true and belong together. |
| `forget` | Archive a fact. |
| `list` | Browse / audit memories, 100 per page, by kind, status, source client, scope, or `since`. |
| `history` | Show how a fact evolved (its superseded versions) and what it is linked to. |

All id-taking tools accept full UUIDs or unique 8-character short ids.

In `auto` mode the agent recalls before remembering, reconciles the similar-memories echo, and calls
these tools proactively; you can also just say "remember this" / "forget that".

## How ranking works

Candidates come from up to three retrieval lists — pgvector cosine (if embeddings are enabled),
`english` full-text, and `simple` full-text (unstemmed, so identifiers and stopword-looking tokens
match literally). Memories linked to the top 5 hits form a fourth list at half weight, each
neighbour scored by its seed's score divided by the seed's link count so a heavily linked memory
does not flood the results. Lists are fused with Reciprocal Rank Fusion, then each candidate's
score is multiplied by a bounded retention factor (0.7–1.0, see strength and fading above), a
bounded salience boost (0.75–1.25), and a project factor (×1.15 same project, ×0.6 another
project, ×1 global). Relevance stays dominant: an old, exactly-matching fact still beats a fresh
vague one. Expired facts (`expires_at` in the past) never surface.

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

- **Works outward from what is new** — it lists only facts created since the last dream and recalls
  their neighbours; it never pages through the whole memory.
- **Fades** long-unused, low-importance memories (a deterministic step before the agent runs).
- **Deduces** new facts — logical implications of what you've stated.
- **Induces** patterns — tendencies spanning ≥ 2 facts, with confidence by evidence count.
- **Resolves contradictions** — supersedes outdated or conflicting facts, keeping the version with
  more information and never merging facts that could both be true.
- **Reconciles near-duplicates** — pairs detected by embedding distance are fed in as candidates.
- **Consolidates** — when many facts cover one narrow topic it writes one gist memory linked to
  them. The details are left in place to fade naturally; they are never rewritten or merged.
- **Links** memories that belong together.
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

## What this design is based on

- **Generative Agents** (arXiv 2304.03442) — retrieval as relevance × recency × importance, with
  recency measured from last use.
- **MemoryBank** (2305.10250) — retention `e^(-t/S)` where recall increases strength `S`.
- **Nemori** (2508.03341) — predict-calibrate extraction: store only what deviates from what is
  already known.
- **Zep / Graphiti** (2501.13956) — invalidate instead of delete; supersede only when two facts
  cannot both be true; never from recency alone.
- **HippoRAG** (2405.14831) — link-following helps only when normalised by degree; naive neighbour
  expansion hurts.
- **LongMemEval** (2410.10813) and **Chroma's context-rot study** — a few focused tokens beat a
  large dump, and even one distractor hurts, hence the gate and the budgets.
- **PrefEval** (2502.09597) — models stop following a preference stated many turns ago, hence
  re-injecting the relevant preference at the request that needs it.
- **Codex CLI memories** and **mem0** — after-the-fact extraction where no-op is the preferred
  outcome and user turns are the evidence.

Deliberately left out, because the evidence at personal scale (thousands of facts, not millions)
did not support them: a graph database with entity extraction, rewriting memories when they are
recalled, and summarising details away. Thresholds such as the gate and the fading constants are
heuristics; they are named constants at the top of `src/db/store.ts`.

## Requirements

- Node ≥ 20.
- For automatic learning: Claude Code on the machine (reflection and the dream run through it), or
  another headless CLI set as `dreamCommand`.
- Optional: your own Postgres instead of the built-in local one. For semantic embeddings it needs
  the `pgvector` extension (Supabase / Neon provide it; self-hosted needs `CREATE EXTENSION
  vector`, done automatically when you enable a provider).

## License

MIT

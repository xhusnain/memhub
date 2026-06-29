# memhub

> Smart, self-maintaining, cross-machine memory for Claude Code — Postgres-backed, no rented LLM brain.

mem0 and Honcho are memory stores that pay a separate LLM (OpenAI) to do the thinking. **memhub**
flips that: in Claude Code the LLM is already in the room, so Claude does the extraction, reasoning, and
background reconciliation itself — for free. The backend is just **Postgres**.

```bash
npm install -g memhub
memhub init
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
- **Background dreaming** — `memhub dream` runs a Honcho-style reasoning pass: it derives new facts
  (logical **deductions** + behavioral **inductions**), resolves contradictions, and maintains a stable
  **peer-card** identity summary — all powered by your own Claude, no rented model. Schedule it with cron.
- **Yours** — plain rows in your own Postgres, no opaque vendor store, no required LLM API key.

## Setup

```bash
npm install -g memhub
memhub init     # global setup, then restart Claude Code
```

The wizard asks for:
- **Postgres connection string** (Supabase / Neon / Railway / self-hosted all work).
- **Namespace** — your identity; the same namespace on another machine shares one brain.
- **Capture mode** — `auto` (recommended) or `manual`.
- **Embeddings provider** — `none` (full-text only), `openai`, `ollama`, or `cloudflare`.

It migrates the schema, registers the MCP server at user scope, and (in `auto` mode) installs a small
instruction block into `~/.claude/CLAUDE.md`.

Add another machine by running the same `init` with the **same Postgres URL, namespace, and capture mode**.

> **Note:** Switching embedding provider or model does **not** re-embed existing memories — older memories
> remain searchable via full-text until they are saved again.

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
| `history` | Show how a fact evolved (its superseded versions). |

In `auto` mode Claude recalls before remembering to avoid duplicates, and calls these tools proactively; you can also just say "remember this" / "forget that".

## Dreaming (background maintenance)

```bash
memhub dream                # run a maintenance pass now
memhub dream --print-cron   # print a crontab line to schedule it
```

The dream is a **Honcho-style reasoning pass** over your distilled facts. It first archives exact-duplicate
memories, then launches a headless Claude (`claude -p`, scoped to **only** the memhub tools — no shell/file
access) that:

- **Deduces** new facts — logical implications of what you've stated (e.g. "writes the Rust scanner" ⇒ "proficient in Rust").
- **Induces** patterns — behavioral tendencies and preferences spanning ≥ 2 facts, with confidence by evidence count.
- **Resolves contradictions** — supersedes outdated or conflicting facts.
- **Maintains a peer-card** — a compact, stable identity summary.

Every memory carries a `level` (`explicit` = what you stated, `deductive`, or `inductive`); derived facts
record their **source memory ids** (provenance), and **only `explicit` facts count toward the auto-trigger**
so the dream can't feed on its own output. The reasoning step needs the `claude` CLI logged in on the machine
running the job; if it's unavailable, the duplicate cleanup still runs and the reasoning step is skipped.

**Two layers, so you know what's automatic:**
- In **auto** capture mode, `memhub serve` runs a lightweight **mechanical de-dupe** on startup when it's been
  a while and new memories have accumulated — no cron, no `claude` needed.
- The **full reasoning dream** also fires **automatically** in auto mode: when `memhub serve` starts and a dream
  is due, it spawns `memhub dream` as a **detached background process** — no cron, no user action. The spawned
  dream sets `MEMHUB_DREAMING=1` so its own nested server skips auto-dream (no recursion). In **manual** capture
  mode, nothing runs on its own.

### Scheduling the nightly dream (optional)

This is an **optional** extra for machines where you rarely open Claude Code (so `serve` seldom starts and the
auto-dream above rarely fires). If you open Claude Code regularly you don't need it.

```bash
memhub schedule             # print the right scheduler for your OS
memhub schedule --install   # install it (writes/loads the job)
```

`memhub schedule` is **cross-platform**: on **Linux** it prints a `cron` line (add it via `crontab -e`, or let
`--install` write your crontab); on **macOS** it prints a **launchd LaunchAgent** plist and `--install` writes it
to `~/Library/LaunchAgents/com.memhub.dream.plist` and `launchctl load`s it. Both run the dream nightly at 03:00,
logging to `~/.memhub/dream.log`.

It sets **PATH** explicitly so the scheduled job can find both `memhub` and `claude` — these usually live in
`nvm` and `~/.local/bin`, which cron/launchd do **not** include in their minimal default PATH.

## Requirements

- Node ≥ 20.
- A Postgres database. For semantic embeddings, Postgres with the `pgvector` extension (Supabase / Neon
  provide it; self-hosted needs `CREATE EXTENSION vector`, done automatically when you enable a provider).

## License

MIT

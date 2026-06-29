import { execFileSync, spawn } from "node:child_process";
import { Pool } from "pg";
import { loadConfig, type Config } from "./config.js";
import { redactUrl } from "./redact.js";
import { migrate } from "./db/migrate.js";
import { MemoryStore } from "./db/store.js";

export function buildDreamPrompt(): string {
  return [
    "You are running an unattended \"dream\" — a higher-order reasoning pass over the user's long-term memory, modeled on Honcho's dreamer. Use the memhub MCP tools (recall, list, remember, supersede, forget, confirm). Work in phases and be conservative.",
    "",
    "PHASE 0 — DISCOVERY: call `recall` and `list` to load what is already known. Understand the landscape before writing anything. Do not duplicate facts that already exist (recall first).",
    "",
    "PHASE 1 — DEDUCTION (logical implications):",
    "- Knowledge updates (HIGHEST priority): if a fact's value changed over time (e.g. \"deploys to Netlify\" then later \"deploys to Vercel\"), call `supersede` to replace the stale fact with the corrected one.",
    "- Logical implications: derive facts that necessarily follow (e.g. \"writes the Rust scanner\" implies \"is proficient in Rust\"). Save each with `remember({ content, level: \"deductive\", source: \"derived from: <source memory ids>\" })`.",
    "- Contradictions: if two facts cannot both be true, reconcile them — `supersede` the wrong/older one, or record a deductive note describing the conflict.",
    "",
    "PHASE 2 — INDUCTION (patterns): find behavioral patterns, preferences, and tendencies that span MULTIPLE facts.",
    "- Require at least 2 supporting facts. Never restate a single fact.",
    "- Save with `remember({ content, level: \"inductive\", tags: [\"pattern:<preference|behavior|personality|tendency>\"], confidence: <2 sources=0.5, 3-4=0.7, 5+=0.9>, source: \"derived from: <source memory ids>\" })`.",
    "",
    "PHASE 3 — PEER CARD (stable identity): maintain ONE compact identity summary as a memory with kind \"peer-card\". Include only STABLE facts (unlikely to change within ~6 months), as short lines each prefixed with IDENTITY:, ATTRIBUTE:, RELATIONSHIP:, or INSTRUCTION:, deduplicated, at most ~40 lines. If a kind \"peer-card\" memory already exists, `supersede` it with the updated version; otherwise `remember` it.",
    "",
    "RULES:",
    "- Ground everything in EXISTING memories — always put the source memory ids in `source`. Do not invent unsupported facts.",
    "- Quality over quantity; be conservative. When unsure, do nothing.",
    "- Always set the correct `level` so derived facts are distinguishable from user-stated (explicit) facts.",
  ].join("\n");
}

export type ClaudeRunner = (prompt: string) => void;

const defaultRunClaude: ClaudeRunner = (prompt) => {
  // Unattended: allow ONLY the memhub memory tools (nothing else — no bash/file edits),
  // so the headless dream can read/write memory without an interactive permission prompt.
  execFileSync(
    "claude",
    [
      "-p", prompt,
      "--allowedTools",
      "mcp__memhub__recall", "mcp__memhub__list", "mcp__memhub__remember",
      "mcp__memhub__supersede", "mcp__memhub__forget", "mcp__memhub__confirm",
      "mcp__memhub__review", "mcp__memhub__history",
    ],
    { stdio: "inherit" }
  );
};

export async function runDreamWith(deps: {
  loadCfg: () => Config;
  connect: (url: string) => Promise<Pool>;
  runClaude: ClaudeRunner;
  log?: (m: string) => void;
}): Promise<{ deduped: number }> {
  const cfg = deps.loadCfg();
  const pool = await deps.connect(cfg.postgresUrl);
  try {
    await migrate(pool);
    const store = new MemoryStore(pool, cfg.namespace);
    const deduped = await store.dedupeExact();
    deps.log?.(`Archived ${deduped} duplicate memories.`);
    try {
      deps.runClaude(buildDreamPrompt());
    } catch (e) {
      deps.log?.(`Semantic pass skipped (claude unavailable): ${redactUrl(e instanceof Error ? e.message : String(e))}`);
    }
    try { await store.markDreamed(); } catch { /* best-effort */ }
    return { deduped };
  } finally {
    await pool.end();
  }
}

export function runDream(): void {
  runDreamWith({
    loadCfg: () => loadConfig(),
    connect: async (url) => new Pool({ connectionString: url }),
    runClaude: defaultRunClaude,
    log: (m) => console.log(m),
  }).catch((err) => {
    console.error(`dream failed: ${redactUrl(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  });
}

export async function maybeAutoConsolidate(
  store: MemoryStore,
  opts: { hours?: number; newThreshold?: number } = {}
): Promise<{ ran: boolean; deduped: number }> {
  const hours = opts.hours ?? 6;
  const newThreshold = opts.newThreshold ?? 5;
  if (!(await store.shouldAutoDream(hours, newThreshold))) return { ran: false, deduped: 0 };
  const deduped = await store.dedupeExact();
  await store.markDreamed();
  return { ran: true, deduped };
}

function spawnDetachedDream(): void {
  // Re-invoke `memhub dream` in the background; MEMHUB_DREAMING guards the nested serve from recursing.
  const child = spawn(process.execPath, [process.argv[1], "dream"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MEMHUB_DREAMING: "1" },
  });
  child.unref();
}

export async function maybeAutoDream(
  store: MemoryStore,
  opts: { hours?: number; newThreshold?: number; spawn?: () => void } = {}
): Promise<{ triggered: boolean }> {
  if (process.env.MEMHUB_DREAMING) return { triggered: false }; // recursion guard
  const hours = opts.hours ?? 6;
  const newThreshold = opts.newThreshold ?? 5;
  if (!(await store.shouldAutoDream(hours, newThreshold))) return { triggered: false };
  await store.markDreamed(); // optimistic lock against concurrent/restart re-trigger
  (opts.spawn ?? spawnDetachedDream)();
  return { triggered: true };
}

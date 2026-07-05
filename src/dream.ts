import { execFileSync, spawn } from "node:child_process";
import { Pool } from "pg";
import { loadConfig, type Config } from "./config.js";
import { redactErr } from "./redact.js";
import { migrate } from "./db/migrate.js";
import { MemoryStore } from "./db/store.js";

const NEAR_DUP_DISTANCE = 0.15;

export function buildDreamPrompt(nearDuplicates: string[] = []): string {
  const lines = [
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
    "- When two facts state the same thing, keep the one with MORE information and supersede the weaker.",
    "- If two facts could both be true (different aspects, different times, or a preference vs an event), KEEP BOTH — never merge on suspicion.",
    "- Never store meta-facts about a conversation ('user shared a file'); store the content itself.",
    "- Rewrite relative time ('yesterday', 'last week') into absolute dates using the memory's created/confirmed dates.",
    "- Memory ids may be used in their 8-character short form.",
  ];
  if (nearDuplicates.length) {
    lines.push(
      "",
      "CANDIDATE NEAR-DUPLICATES (by embedding distance — reconcile each pair: supersede/forget the weaker, or keep both if they state different facts):",
      ...nearDuplicates.map((d) => "- " + d)
    );
  }
  return lines.join("\n");
}

export type ClaudeRunner = (prompt: string) => void;

const defaultRunClaude: ClaudeRunner = (prompt) => {
  execFileSync(
    "claude",
    [
      "-p", prompt,
      "--allowedTools",
      "mcp__memhub__recall", "mcp__memhub__list", "mcp__memhub__remember",
      "mcp__memhub__supersede", "mcp__memhub__forget", "mcp__memhub__confirm",
      "mcp__memhub__review", "mcp__memhub__history", "mcp__memhub__context",
    ],
    { stdio: "inherit" }
  );
};

export function makeRunner(dreamCommand?: string[]): ClaudeRunner {
  if (dreamCommand?.length) {
    return (prompt) => {
      execFileSync(dreamCommand[0], [...dreamCommand.slice(1), prompt], { stdio: "inherit" });
    };
  }
  return defaultRunClaude;
}

async function nearDuplicateLines(pool: Pool, namespace: string): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      `select substr(a.id::text, 1, 8) as ia, a.content as ca,
              substr(b.id::text, 1, 8) as ib, b.content as cb,
              round((ea.embedding <=> eb.embedding)::numeric, 3) as d
       from memories a
       join memory_embeddings ea on ea.memory_id = a.id
       join memories b on b.namespace = a.namespace and b.status = 'active' and b.id > a.id
         and (b.expires_at is null or b.expires_at > now())
       join memory_embeddings eb on eb.memory_id = b.id
         and eb.provider = ea.provider and eb.model = ea.model and eb.dim = ea.dim
       where a.namespace = $1 and a.status = 'active'
         and (a.expires_at is null or a.expires_at > now())
         and (ea.embedding <=> eb.embedding) < ${NEAR_DUP_DISTANCE}
       order by 5 asc limit 20`,
      [namespace]
    );
    return rows.map((r) => `[${r.ia}] ${r.ca}  <->  [${r.ib}] ${r.cb}  (distance ${r.d})`);
  } catch {
    return [];
  }
}

export async function runDreamWith(deps: {
  loadCfg: () => Config;
  connect: (url: string) => Promise<Pool>;
  runClaude?: ClaudeRunner;
  log?: (m: string) => void;
}): Promise<{ skipped: boolean }> {
  const cfg = deps.loadCfg();
  const pool = await deps.connect(cfg.postgresUrl);
  try {
    const lockConn = await pool.connect();
    try {
      const { rows } = await lockConn.query("select pg_try_advisory_lock(hashtext('memhub:dream'), hashtext($1)) as ok", [cfg.namespace]);
      if (rows[0].ok !== true) {
        deps.log?.("Another dream is already running — skipped.");
        return { skipped: true };
      }
      await migrate(pool);
      const store = new MemoryStore(pool, cfg.namespace);
      const candidates = await nearDuplicateLines(pool, cfg.namespace);
      const run = deps.runClaude ?? makeRunner(cfg.dreamCommand);
      let reasoned = true;
      try {
        run(buildDreamPrompt(candidates));
      } catch (e) {
        reasoned = false;
        deps.log?.(`Semantic pass skipped (claude unavailable): ${redactErr(e)}`);
      }
      if (reasoned) {
        try { await store.markDreamed(); } catch {}
      }
      return { skipped: false };
    } finally {
      lockConn.release();
    }
  } finally {
    await pool.end();
  }
}

export function runDream(): void {
  runDreamWith({
    loadCfg: () => loadConfig(),
    connect: async (url) => new Pool({ connectionString: url }),
    log: (m) => console.log(m),
  }).catch((err) => {
    console.error(`dream failed: ${redactErr(err)}`);
    process.exit(1);
  });
}

function spawnDetachedDream(): void {
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
  if (process.env.MEMHUB_DREAMING) return { triggered: false };
  const hours = opts.hours ?? 6;
  const newThreshold = opts.newThreshold ?? 5;
  if (!(await store.shouldAutoDream(hours, newThreshold))) return { triggered: false };
  (opts.spawn ?? spawnDetachedDream)();
  return { triggered: true };
}

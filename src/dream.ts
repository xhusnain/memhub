import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Pool } from "pg";
import { loadConfig, type Config } from "./config.js";
import { redactErr } from "./redact.js";
import { migrate } from "./db/migrate.js";
import { MemoryStore } from "./db/store.js";
import { openPool } from "./localdb.js";

const NEAR_DUP_DISTANCE = 0.15;

export function buildDreamPrompt(nearDuplicates: string[] = [], opts: { since?: string | null; faded?: number } = {}): string {
  const lines = [
    "You are running an unattended \"dream\" — the sleep-time consolidation pass over the user's long-term memory, modeled on Honcho's dreamer. Use the memhub MCP tools (recall, list, remember, supersede, link, forget, confirm, history). Work in phases and be conservative.",
    "",
    opts.since
      ? `PHASE 0 — DISCOVERY: the last dream ran at ${opts.since}. Load only what is new with \`list({ since: "${opts.since}" })\` (page with \`offset\` if it says more exist). For each new fact, \`recall\` its topic to bring up the older memories it touches. Never page through the whole memory — work outward from what is new.`
      : "PHASE 0 — DISCOVERY: this is the first dream. Page through memory with `list` (100 per page, use `offset`) and `recall` topics that look related. Understand the landscape before writing anything.",
    "Do not duplicate facts that already exist (recall first).",
    "",
    "PHASE 1 — DEDUCTION (logical implications):",
    "- Knowledge updates (HIGHEST priority): if a fact's value changed over time (e.g. \"deploys to Netlify\" then later \"deploys to Vercel\"), call `supersede` on the stale fact with the corrected one and a short `reason`.",
    "- Logical implications: derive facts that necessarily follow (e.g. \"writes the Rust scanner\" implies \"is proficient in Rust\"). Save each with `remember({ content, level: \"deductive\", source: \"derived from: <source memory ids>\", links: [<source memory ids>] })`.",
    "- Contradictions: if two facts cannot both be true, reconcile them — `supersede` the wrong/older one, or record a deductive note describing the conflict.",
    "- Promotion: a tentative memory (confidence below 0.5) that a second independent memory supports should be `confirm`ed so it becomes trusted.",
    "",
    "PHASE 2 — INDUCTION (patterns): find behavioral patterns, preferences, and tendencies that span MULTIPLE facts.",
    "- Require at least 2 supporting facts. Never restate a single fact.",
    "- Save with `remember({ content, level: \"inductive\", tags: [\"pattern:<preference|behavior|personality|tendency>\"], confidence: <2 sources=0.5, 3-4=0.7, 5+=0.9>, source: \"derived from: <source memory ids>\", links: [<source memory ids>] })`.",
    "",
    "PHASE 3 — CONSOLIDATION (gist over detail): when 4 or more active facts cover one narrow topic (e.g. the user's video style), write ONE gist memory that states the general rule, with `salience` at least as high as the highest detail, and pass the detail ids in `links` (then `link` with relation \"summarizes\" where useful). Leave the details in place — do NOT forget, supersede, or rewrite them. Unused details fade on their own; the gist and its links keep them reachable.",
    "",
    "PHASE 4 — ASSOCIATION: `link` memories that are both true and belong together but are not yet connected (same topic, cause and effect, a rule and its example or exception). Recall follows links one step, so link only what should surface together.",
    "",
    "PHASE 5 — PEER CARD (stable identity): maintain ONE compact identity summary as a memory with kind \"peer-card\". Include only STABLE facts (unlikely to change within ~6 months), as short lines each prefixed with IDENTITY:, ATTRIBUTE:, RELATIONSHIP:, or INSTRUCTION:, deduplicated, at most ~40 lines. INSTRUCTION: lines carry the user's standing working rules. If a kind \"peer-card\" memory already exists, `supersede` it with the updated version; otherwise `remember` it.",
    "",
    "RULES:",
    "- Ground everything in EXISTING memories — always put the source memory ids in `source`. Do not invent unsupported facts.",
    "- Quality over quantity; be conservative. When unsure, do nothing.",
    "- Always set the correct `level` so derived facts are distinguishable from user-stated (explicit) facts.",
    "- When two facts state the same thing, keep the one with MORE information and supersede the weaker.",
    "- If two facts could both be true (different aspects, different times, different projects, or a preference vs an event), KEEP BOTH and `link` them — never merge on suspicion, and never supersede merely because one is newer.",
    "- Never store meta-facts about a conversation ('user shared a file'); store the content itself.",
    "- Rewrite relative time ('yesterday', 'last week') into absolute dates using the memory's created/confirmed dates.",
    "- Memory ids may be used in their 8-character short form.",
  ];
  if (opts.faded) {
    lines.push("", `NOTE: ${opts.faded} long-unused, low-salience memories just faded out of active recall. They are not deleted; \`recall\` with deep: true still finds and revives them.`);
  }
  if (nearDuplicates.length) {
    lines.push(
      "",
      "CANDIDATE NEAR-DUPLICATES (by embedding distance — reconcile each pair: supersede/forget the weaker, or keep both if they state different facts):",
      ...nearDuplicates.map((d) => "- " + d)
    );
  }
  return lines.join("\n");
}

export type RunOptions = { project?: string | null };
export type ClaudeRunner = (prompt: string, opts?: RunOptions) => void;

const MEMHUB_TOOLS = [
  "recall", "list", "remember", "supersede", "forget", "confirm", "review", "history", "context", "link",
].map((t) => "mcp__memhub__" + t);

function childOptions(opts: RunOptions | undefined, baseDir: string) {
  return {
    stdio: "inherit" as const,
    cwd: existsSync(baseDir) ? baseDir : undefined,
    env: { ...process.env, MEMHUB_DREAMING: "1", MEMHUB_PROJECT: opts?.project ?? "" },
  };
}

export function makeRunner(dreamCommand?: string[], baseDir = join(homedir(), ".memhub")): ClaudeRunner {
  if (dreamCommand?.length) {
    return (prompt, opts) => {
      execFileSync(dreamCommand[0], [...dreamCommand.slice(1), prompt], childOptions(opts, baseDir));
    };
  }
  return (prompt, opts) => {
    execFileSync("claude", ["-p", prompt, "--allowedTools", ...MEMHUB_TOOLS], childOptions(opts, baseDir));
  };
}

async function nearDuplicateLines(pool: Pool, namespace: string, since: string | null): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      `select substr(a.id::text, 1, 8) as ia, a.content as ca,
              substr(b.id::text, 1, 8) as ib, b.content as cb,
              round((ea.embedding <=> eb.embedding)::numeric, 3) as d
       from memories a
       join memory_embeddings ea on ea.memory_id = a.id
       join memories b on b.namespace = a.namespace and b.status = 'active' and b.id <> a.id
         and (b.expires_at is null or b.expires_at > now())
         and (b.id > a.id or ($2::timestamptz is not null and b.created_at <= $2::timestamptz))
       join memory_embeddings eb on eb.memory_id = b.id
         and eb.provider = ea.provider and eb.model = ea.model and eb.dim = ea.dim
       where a.namespace = $1 and a.status = 'active'
         and (a.expires_at is null or a.expires_at > now())
         and ($2::timestamptz is null or a.created_at > $2::timestamptz)
         and (ea.embedding <=> eb.embedding) < ${NEAR_DUP_DISTANCE}
       order by 5 asc limit 20`,
      [namespace, since]
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
      const since = await store.lastDreamAt().catch(() => null);
      const faded = await store.fade().catch(() => 0);
      if (faded) deps.log?.(`Faded ${faded} long-unused memories.`);
      const candidates = await nearDuplicateLines(pool, cfg.namespace, since);
      const run = deps.runClaude ?? makeRunner(cfg.dreamCommand);
      let reasoned = true;
      try {
        run(buildDreamPrompt(candidates, { since, faded }));
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
    connect: (url) => openPool(url),
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

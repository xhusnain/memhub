import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Pool } from "pg";
import { loadConfig, type Config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { MemoryStore, type Memory } from "./db/store.js";
import { createEmbedder } from "./embeddings/registry.js";
import { fmtBrief, withinBudget } from "./format.js";
import { projectKey } from "./project.js";
import { enqueueSession, pendingSessions, queueDir, spawnDetachedReflect } from "./reflect.js";
import { redactErr } from "./redact.js";
import { openPool } from "./localdb.js";

const START_BUDGET_CHARS = 2400;
const PEER_CARD_MAX_CHARS = 1200;
const PROMPT_BUDGET_CHARS = 900;
const PROMPT_K = 3;
const LINE_MAX_CHARS = 280;
const PROMPT_MIN_CHARS = 12;
const DB_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 6000;

export type HookEvent = "session-start" | "prompt" | "pre-compact" | "session-end";

export type HookInput = {
  session_id?: string; transcript_path?: string; cwd?: string;
  hook_event_name?: string; prompt?: string; source?: string;
};

export type HookDeps = {
  loadCfg: () => Config;
  connect: (url: string) => Promise<Pool>;
  baseDir: string;
  spawnReflect: () => void;
  env: NodeJS.ProcessEnv;
};

function line(m: Memory): string {
  const content = m.content.length > LINE_MAX_CHARS ? m.content.slice(0, LINE_MAX_CHARS - 1) + "…" : m.content;
  return fmtBrief({ ...m, content });
}

async function withStore<T>(deps: HookDeps, cfg: Config, fn: (store: MemoryStore) => Promise<T>): Promise<T> {
  const pool = await deps.connect(cfg.postgresUrl);
  try {
    await migrate(pool);
    return await fn(new MemoryStore(pool, cfg.namespace, createEmbedder(cfg.embeddings) ?? undefined));
  } finally {
    await pool.end().catch(() => {});
  }
}

async function sessionStart(deps: HookDeps, cfg: Config, input: HookInput): Promise<string> {
  if (pendingSessions(queueDir(deps.baseDir)).length) deps.spawnReflect();
  if (input.source === "resume") return "";
  const project = projectKey(input.cwd);
  const c = await withStore(deps, cfg, (store) => store.context(project));
  const parts: string[] = [];
  let budget = START_BUDGET_CHARS;
  if (c.peerCard) {
    const card = c.peerCard.content.length > PEER_CARD_MAX_CHARS
      ? c.peerCard.content.slice(0, PEER_CARD_MAX_CHARS - 1) + "…"
      : c.peerCard.content;
    parts.push(`ABOUT THE USER:\n${card}`);
    budget -= card.length;
  }
  const lines = withinBudget([...c.top, ...c.recent].map(line), Math.max(0, budget));
  if (lines.length) parts.push(`KEY MEMORIES:\n${lines.join("\n")}`);
  if (!parts.length) return "";
  return [
    "[memhub] Long-term memory about this user, loaded automatically. Apply it silently; do not ask the user what it already answers. More is injected per request when relevant, and `recall` searches the rest.",
    ...parts,
  ].join("\n\n");
}

async function promptSubmit(deps: HookDeps, cfg: Config, input: HookInput): Promise<string> {
  const prompt = (input.prompt ?? "").trim();
  if (prompt.length < PROMPT_MIN_CHARS || prompt.startsWith("/")) return "";
  const project = projectKey(input.cwd);
  const hits = await withStore(deps, cfg, (store) => store.recall(prompt, PROMPT_K, { gate: true, project }));
  const lines = withinBudget(hits.map(line), PROMPT_BUDGET_CHARS);
  if (!lines.length) return "";
  return `[memhub] Memories that may apply to this request (the user's own past preferences and facts; [was: …] marks a value that changed):\n${lines.join("\n")}`;
}

function sessionEnd(deps: HookDeps, input: HookInput): string {
  if (!input.session_id || !input.transcript_path) return "";
  enqueueSession(
    {
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
      cwd: input.cwd ?? null,
      project: projectKey(input.cwd),
      client: deps.env.MEMHUB_CLIENT ?? null,
    },
    queueDir(deps.baseDir)
  );
  deps.spawnReflect();
  return "";
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function handleHook(event: string, input: HookInput, deps: HookDeps): Promise<string> {
  if (deps.env.MEMHUB_DREAMING) return "";
  let cfg: Config;
  try { cfg = deps.loadCfg(); } catch { return ""; }
  if (cfg.captureMode !== "auto") return "";
  switch (event) {
    case "session-start": return timeout(sessionStart(deps, cfg, input), DB_TIMEOUT_MS);
    case "prompt": return timeout(promptSubmit(deps, cfg, input), DB_TIMEOUT_MS);
    case "pre-compact":
    case "session-end": return sessionEnd(deps, input);
    default: return "";
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function logError(baseDir: string, event: string, err: unknown): void {
  try {
    mkdirSync(baseDir, { recursive: true });
    appendFileSync(join(baseDir, "hooks.log"), `${new Date().toISOString()} ${event}: ${redactErr(err)}\n`);
  } catch {}
}

export async function runHook(event: string | undefined, asJson: boolean): Promise<void> {
  const baseDir = join(homedir(), ".memhub");
  let out = "";
  let input: HookInput = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
    out = await handleHook(event ?? "", input, {
      loadCfg: () => loadConfig(),
      connect: (url) => openPool(url, { connectionTimeoutMillis: CONNECT_TIMEOUT_MS }),
      baseDir,
      spawnReflect: spawnDetachedReflect,
      env: process.env,
    });
  } catch (e) {
    logError(baseDir, event ?? "?", e);
  }
  if (!out) process.exit(0);
  const text = asJson
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? "", additionalContext: out } })
    : out + "\n";
  process.stdout.write(text, () => process.exit(0));
}

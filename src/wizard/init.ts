import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { Pool } from "pg";
import * as p from "@clack/prompts";
import { saveConfig, loadConfig, type Config } from "../config.js";
import { migrate } from "../db/migrate.js";
import { migrateEmbeddings } from "../db/migrate-embeddings.js";
import { registerUserMcp } from "./register-mcp.js";
import { applyCaptureSnippet } from "./capture-snippet.js";
import { redactUrl } from "../redact.js";

export interface InitIO {
  text(opts: { message: string; placeholder?: string; defaultValue?: string }): Promise<string>;
  select(opts: { message: string; options: { value: string; label: string; hint?: string }[]; initialValue?: string }): Promise<string>;
  password(opts: { message: string }): Promise<string>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  step<T>(message: string, fn: () => Promise<T>): Promise<T>;
  info(message: string): void;
}

type ConnInfo = { pool: Pool; hasVector: boolean };
type Conn = { pool: Pool; hasVector: boolean; url: string };

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function connectedMsg(hasVector: boolean): string {
  return hasVector ? "✓ Connected (pgvector available)" : "✓ Connected (no pgvector — full-text only)";
}
function tryLoadConfig(dir: string): Config | undefined {
  try { return loadConfig(dir); } catch { return undefined; }
}

async function connectAndValidate(connect: (url: string) => Promise<Pool>, url: string): Promise<ConnInfo> {
  const pool = await connect(url);
  try {
    await pool.query("select 1");
    const { rows } = await pool.query("select exists(select 1 from pg_available_extensions where name='vector') as has");
    return { pool, hasVector: rows[0]?.has === true };
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
}

async function getValidatedConnection(
  io: InitIO,
  connect: (url: string) => Promise<Pool>,
  opts: { savedUrl?: string; trySavedSilently?: boolean }
): Promise<Conn> {
  if (opts.savedUrl && opts.trySavedSilently) {
    try {
      const info = await io.step("Connecting to Postgres", () => connectAndValidate(connect, opts.savedUrl!));
      io.info(connectedMsg(info.hasVector));
      return { pool: info.pool, hasVector: info.hasVector, url: opts.savedUrl };
    } catch (e) {
      io.info(`✗ Saved connection failed: ${redactUrl(msg(e))} — enter a new one (Ctrl-C to cancel)`);
    }
  }
  for (;;) {
    const url = (await io.text({ message: "Postgres connection string", defaultValue: opts.savedUrl })).trim();
    try {
      const info = await io.step("Connecting to Postgres", () => connectAndValidate(connect, url));
      io.info(connectedMsg(info.hasVector));
      return { pool: info.pool, hasVector: info.hasVector, url };
    } catch (e) {
      io.info(`✗ Could not connect: ${redactUrl(msg(e))} — fix the URL and try again (Ctrl-C to cancel)`);
    }
  }
}

async function getSecret(io: InitIO, label: string, existing?: string): Promise<string> {
  if (existing) {
    const reuse = await io.confirm({ message: `Reuse the existing ${label}?`, initialValue: true });
    if (reuse) return existing;
  }
  return io.password({ message: label });
}

async function promptEmbeddings(io: InitIO, hasVector: boolean, existing?: Config["embeddings"]): Promise<Config["embeddings"]> {
  const provider = await io.select({
    message: "Embeddings provider",
    initialValue: existing?.provider ?? "none",
    options: [
      { value: "none", label: "None", hint: "full-text search only — no setup" },
      { value: "openai", label: "OpenAI", hint: "hosted, needs API key" },
      { value: "ollama", label: "Ollama", hint: "local, no key" },
      { value: "cloudflare", label: "Cloudflare Workers AI", hint: "hosted, needs account + token" },
    ],
  });
  if (provider === "none") return { provider: "none" };
  if (!hasVector) io.info("⚠ pgvector is not available on this database — semantic search needs the 'vector' extension. Saving the provider anyway.");

  if (provider === "openai") {
    const prev = existing?.provider === "openai" ? existing : undefined;
    const model = (await io.text({ message: "OpenAI embedding model", defaultValue: prev?.model ?? "text-embedding-3-small" })) || "text-embedding-3-small";
    const apiKey = await getSecret(io, "OpenAI API key", prev?.apiKey);
    return { provider: "openai", model, apiKey };
  }
  if (provider === "ollama") {
    const prev = existing?.provider === "ollama" ? existing : undefined;
    const model = (await io.text({ message: "Ollama embedding model", defaultValue: prev?.model ?? "nomic-embed-text" })) || "nomic-embed-text";
    const baseUrl = (await io.text({ message: "Ollama base URL", defaultValue: prev?.baseUrl ?? "http://localhost:11434" })) || "http://localhost:11434";
    return { provider: "ollama", model, baseUrl };
  }
  const prev = existing?.provider === "cloudflare" ? existing : undefined;
  const model = await io.select({
    message: "Cloudflare embedding model",
    initialValue: prev?.model ?? "@cf/baai/bge-base-en-v1.5",
    options: [
      { value: "@cf/baai/bge-base-en-v1.5", label: "bge-base-en-v1.5", hint: "768 dim" },
      { value: "@cf/baai/bge-small-en-v1.5", label: "bge-small-en-v1.5", hint: "384 dim" },
      { value: "@cf/baai/bge-large-en-v1.5", label: "bge-large-en-v1.5", hint: "1024 dim" },
    ],
  });
  const accountId = (await io.text({ message: "Cloudflare account ID", defaultValue: prev?.accountId })).trim() || (prev?.accountId ?? "");
  const apiToken = await getSecret(io, "Cloudflare API token", prev?.apiToken);
  return { provider: "cloudflare", model, accountId, apiToken };
}

async function finalize(
  deps: { io: InitIO; configDir: string; claudeMdPath: string; registerMcp: (command: string, args: string[]) => void },
  pool: Pool,
  cfg: Config
): Promise<void> {
  try {
    await deps.io.step("Setting up schema", async () => {
      await migrate(pool);
      if (cfg.embeddings.provider !== "none") await migrateEmbeddings(pool);
    });
  } finally {
    await pool.end().catch(() => {});
  }
  saveConfig(cfg, deps.configDir);
  await deps.io.step("Registering with Claude Code", async () => { deps.registerMcp("memhub", ["serve"]); });
  applyCaptureSnippet(deps.claudeMdPath, cfg.captureMode);
}

export async function runInitWith(deps: {
  io: InitIO;
  connect: (url: string) => Promise<Pool>;
  configDir: string;
  claudeMdPath: string;
  registerMcp: (command: string, args: string[]) => void;
  defaultNamespace?: string;
}): Promise<void> {
  const existing = tryLoadConfig(deps.configDir);

  if (existing) {
    const action = await deps.io.select({
      message: `Found existing config (namespace "${existing.namespace}", embeddings: ${existing.embeddings.provider}).`,
      initialValue: "keep",
      options: [
        { value: "keep", label: "Keep & re-apply", hint: "re-run setup with saved settings (use after an update)" },
        { value: "reconfigure", label: "Reconfigure", hint: "change settings (current values pre-filled)" },
      ],
    });
    if (action === "keep") {
      const conn = await getValidatedConnection(deps.io, deps.connect, { savedUrl: existing.postgresUrl, trySavedSilently: true });
      await finalize(deps, conn.pool, { ...existing, postgresUrl: conn.url });
      return;
    }
    await runWizard(deps, existing);
    return;
  }
  await runWizard(deps, undefined);
}

async function runWizard(deps: {
  io: InitIO;
  connect: (url: string) => Promise<Pool>;
  configDir: string;
  claudeMdPath: string;
  registerMcp: (command: string, args: string[]) => void;
  defaultNamespace?: string;
}, existing: Config | undefined): Promise<void> {
  const conn = await getValidatedConnection(deps.io, deps.connect, { savedUrl: existing?.postgresUrl });
  const nsAnswer = (await deps.io.text({ message: "Namespace (shared across machines)", defaultValue: existing?.namespace ?? deps.defaultNamespace })).trim();
  const namespace = nsAnswer || existing?.namespace || deps.defaultNamespace || "default";
  const captureMode = (await deps.io.select({
    message: "Capture mode",
    initialValue: existing?.captureMode ?? "auto",
    options: [
      { value: "auto", label: "Auto", hint: "Claude saves silently as you work (recommended)" },
      { value: "manual", label: "Manual", hint: "save only when you ask" },
    ],
  })) as "auto" | "manual";
  const embeddings = await promptEmbeddings(deps.io, conn.hasVector, existing?.embeddings);
  await finalize(deps, conn.pool, { postgresUrl: conn.url, namespace, captureMode, embeddings });
}

function safeUsername(): string | undefined {
  try { return userInfo().username || undefined; } catch { return undefined; }
}

const realIO: InitIO = {
  async text(opts) {
    const v = await p.text({ message: opts.message, placeholder: opts.placeholder, defaultValue: opts.defaultValue, initialValue: opts.defaultValue });
    if (p.isCancel(v)) { p.cancel("Aborted."); process.exit(1); }
    return ((v as string) ?? "").toString();
  },
  async select(opts) {
    const v = await p.select({ message: opts.message, options: opts.options, initialValue: opts.initialValue });
    if (p.isCancel(v)) { p.cancel("Aborted."); process.exit(1); }
    return v as string;
  },
  async password(opts) {
    const v = await p.password({ message: opts.message });
    if (p.isCancel(v)) { p.cancel("Aborted."); process.exit(1); }
    return (v as string) ?? "";
  },
  async confirm(opts) {
    const v = await p.confirm({ message: opts.message, initialValue: opts.initialValue });
    if (p.isCancel(v)) { p.cancel("Aborted."); process.exit(1); }
    return v as boolean;
  },
  async step(message, fn) {
    const s = p.spinner();
    s.start(message + "…");
    try { const r = await fn(); s.stop(message + " ✓"); return r; }
    catch (e) { s.stop(message + " ✗"); throw e; }
  },
  info(message) { p.log.info(message); },
};

export function runInit(): void {
  (async () => {
    p.intro("memhub init");
    await runInitWith({
      io: realIO,
      connect: async (url) => new Pool({ connectionString: url }),
      configDir: join(homedir(), ".memhub"),
      claudeMdPath: join(homedir(), ".claude", "CLAUDE.md"),
      registerMcp: (command, args) => registerUserMcp(command, args),
      defaultNamespace: safeUsername(),
    });
    p.outro("Done. Restart Claude Code — memory tools are available in every project.");
  })().catch((err) => {
    p.cancel(`Error: ${redactUrl(err instanceof Error ? err.message : String(err))}`);
    process.exit(1);
  });
}

import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { Pool } from "pg";
import * as p from "@clack/prompts";
import { saveConfig, loadConfig, type Config } from "../config.js";
import { migrate } from "../db/migrate.js";
import { migrateEmbeddings } from "../db/migrate-embeddings.js";
import { CLIENTS, clientByKey, detectClients, registerClient, unregisterClient, type Run, type Which } from "../clients.js";
import { applyCaptureSnippet } from "./capture-snippet.js";
import { redactUrl, redactErr } from "../redact.js";
import { ensureLocalDb, localSupported, setupLocalDb, type LocalSetup } from "../localdb.js";
import { VERSION } from "../version.js";
import { adjustPostgresUrl } from "../db/url.js";
import { execFileSync } from "node:child_process";

export interface InitIO {
  text(opts: { message: string; placeholder?: string; defaultValue?: string }): Promise<string>;
  select(opts: { message: string; options: { value: string; label: string; hint?: string }[]; initialValue?: string }): Promise<string>;
  multiselect(opts: { message: string; options: { value: string; label: string; hint?: string }[]; initialValues?: string[] }): Promise<string[]>;
  password(opts: { message: string }): Promise<string>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  step<T>(message: string, fn: () => Promise<T>): Promise<T>;
  info(message: string): void;
}

type Deps = {
  io: InitIO;
  connect: (url: string) => Promise<Pool>;
  configDir: string;
  home: string;
  run?: Run;
  which?: Which;
  defaultNamespace?: string;
  local?: {
    supported(): boolean;
    setup(baseDir: string): Promise<LocalSetup>;
    ensure(cfg: Pick<Config, "localDb">): Promise<void>;
  };
  selfInstall?: { needed(): boolean; install(): void };
  command?: () => string | null;
  options?: { yes?: boolean; url?: string };
};

type ConnInfo = { pool: Pool; hasVector: boolean };
type Conn = { pool: Pool; hasVector: boolean; url: string };

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
  opts: { savedUrl?: string; trySavedSilently?: boolean; fixedUrl?: string; interactive?: boolean }
): Promise<Conn> {
  if (opts.fixedUrl || opts.interactive === false) {
    const adjusted = adjustPostgresUrl(opts.fixedUrl ?? opts.savedUrl ?? "");
    const url = adjusted.url;
    if (!url) throw new Error("No database to connect to. Pass --url <postgres-url>, or run memhub init without --yes.");
    for (const note of adjusted.notes) io.info(note);
    const info = await io.step("Connecting to Postgres", () => connectAndValidate(connect, url));
    io.info(connectedMsg(info.hasVector));
    return { pool: info.pool, hasVector: info.hasVector, url };
  }
  if (opts.savedUrl && opts.trySavedSilently) {
    try {
      const adjusted = adjustPostgresUrl(opts.savedUrl);
      for (const note of adjusted.notes) io.info(note);
      const info = await io.step("Connecting to Postgres", () => connectAndValidate(connect, adjusted.url));
      io.info(connectedMsg(info.hasVector));
      return { pool: info.pool, hasVector: info.hasVector, url: adjusted.url };
    } catch (e) {
      io.info(`✗ Saved connection failed: ${redactErr(e)} — enter a new one (Ctrl-C to cancel)`);
    }
  }
  for (;;) {
    const adjusted = adjustPostgresUrl(await io.text({ message: "Postgres connection string", defaultValue: opts.savedUrl }));
    const url = adjusted.url;
    for (const note of adjusted.notes) io.info(note);
    try {
      const info = await io.step("Connecting to Postgres", () => connectAndValidate(connect, url));
      io.info(connectedMsg(info.hasVector));
      return { pool: info.pool, hasVector: info.hasVector, url };
    } catch (e) {
      io.info(`✗ Could not connect: ${redactErr(e)} — fix the URL and try again (Ctrl-C to cancel)`);
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

async function promptClients(deps: Deps, existing?: Config): Promise<string[]> {
  const detected = detectClients(deps.home, deps.which);
  const initial = (existing?.clients ?? [...new Set(["claude", ...detected])])
    .filter((k) => clientByKey(k));
  const chosen = await deps.io.multiselect({
    message: "Register memhub with these AI CLIs",
    options: CLIENTS.map((c) => ({
      value: c.key,
      label: c.title,
      hint: detected.includes(c.key) ? "detected" : "not detected",
    })),
    initialValues: initial,
  });
  return chosen.length ? chosen : ["claude"];
}

async function finalize(deps: Deps, pool: Pool, cfg: Config): Promise<void> {
  try {
    await deps.io.step("Setting up schema", async () => {
      await migrate(pool);
      if (cfg.embeddings.provider !== "none") await migrateEmbeddings(pool);
    });
  } finally {
    await pool.end().catch(() => {});
  }
  saveConfig(cfg, deps.configDir);
  if (deps.selfInstall?.needed()) {
    const ok = await deps.io.confirm({
      message: `Install memhub on this machine so your AI CLIs can start it? (npm install -g memhub@${VERSION})`,
      initialValue: true,
    });
    if (ok) {
      try {
        await deps.io.step("Installing memhub", async () => deps.selfInstall!.install());
      } catch (e) {
        deps.io.info(`✗ Install failed: ${redactErr(e)} — run it yourself: npm install -g memhub`);
      }
    } else {
      deps.io.info("⚠ Skipped. Your AI CLIs need the memhub command on PATH — run: npm install -g memhub");
    }
  }
  const bin = deps.command?.() ?? "memhub";
  if (bin !== "memhub") {
    deps.io.info(`memhub is not on your PATH, so your AI CLIs will start it from ${bin}`);
  }
  for (const key of cfg.clients) {
    if (!clientByKey(key)) deps.io.info(`✗ ${key}: unknown client`);
  }
  const chosen = new Set(cfg.clients);
  for (const adapter of CLIENTS) {
    const instructions = adapter.instructionsFile(deps.home);
    if (!chosen.has(adapter.key)) {
      try { unregisterClient(adapter.key, deps.home, deps.run); } catch {}
      try { adapter.removeHooks?.(deps.home); } catch {}
      if (instructions) {
        try { applyCaptureSnippet(instructions, "manual"); } catch {}
      }
      continue;
    }
    let registered = false;
    try {
      registerClient(adapter.key, deps.home, deps.run, bin);
      registered = true;
      deps.io.info(`✓ ${adapter.title} registered`);
    } catch (e) {
      deps.io.info(`✗ ${adapter.title}: ${redactErr(e)}`);
    }
    if (adapter.installHooks && adapter.removeHooks) {
      try {
        if (registered && cfg.captureMode === "auto") {
          adapter.installHooks(deps.home, bin);
          deps.io.info(`✓ ${adapter.title} hooks installed (automatic recall and after-session reflection)`);
        } else {
          adapter.removeHooks(deps.home);
        }
      } catch (e) {
        deps.io.info(`✗ ${adapter.title} hooks: ${redactErr(e)}`);
      }
    }
    if (instructions && (registered || cfg.captureMode === "manual")) {
      try {
        applyCaptureSnippet(instructions, cfg.captureMode);
      } catch (e) {
        deps.io.info(`✗ ${adapter.title} instructions: ${redactErr(e)}`);
      }
    }
  }
}

async function chooseDatabase(
  deps: Deps, existing: Config | undefined, quick: boolean
): Promise<{ conn: Conn; localDb?: Config["localDb"] }> {
  const interactive = deps.options?.yes !== true;
  if (deps.options?.url) {
    return { conn: await getValidatedConnection(deps.io, deps.connect, { fixedUrl: deps.options.url }) };
  }
  const local = deps.local?.supported() ? deps.local : undefined;
  let where = "url";
  if (local) {
    where = quick ? "local" : await deps.io.select({
      message: "Where should memory be stored?",
      initialValue: existing && !existing.localDb ? "url" : "local",
      options: [
        { value: "local", label: "On this machine", hint: "nothing to set up — memhub runs its own small Postgres" },
        { value: "url", label: "My own Postgres", hint: "Supabase / Neon / self-hosted — shares one memory across machines" },
      ],
    });
  }
  if (where === "local" && local) {
    try {
      const setup = await deps.io.step(
        "Preparing the local database (the first run downloads Postgres, about 130 MB)",
        () => local.setup(deps.configDir)
      );
      const info = await connectAndValidate(deps.connect, setup.postgresUrl);
      deps.io.info("✓ Local database ready");
      return { conn: { pool: info.pool, hasVector: info.hasVector, url: setup.postgresUrl }, localDb: setup.localDb };
    } catch (e) {
      deps.io.info(`✗ The local database could not be set up: ${redactErr(e)} — use a Postgres URL instead`);
    }
  }
  const savedUrl = existing && !existing.localDb ? existing.postgresUrl : undefined;
  return { conn: await getValidatedConnection(deps.io, deps.connect, { savedUrl, interactive }) };
}

export async function runInitWith(deps: Deps): Promise<void> {
  const existing = tryLoadConfig(deps.configDir);

  if (existing && !deps.options?.url) {
    const action = await deps.io.select({
      message: `Found existing config (namespace "${existing.namespace}", ${existing.localDb ? "local database" : "your own Postgres"}, embeddings: ${existing.embeddings.provider}).`,
      initialValue: "keep",
      options: [
        { value: "keep", label: "Keep & re-apply", hint: "re-run setup with saved settings (use after an update)" },
        { value: "reconfigure", label: "Reconfigure", hint: "change settings (current values pre-filled)" },
      ],
    });
    if (action === "keep") {
      if (existing.localDb && deps.local) {
        try {
          await deps.io.step("Starting the local database", () => deps.local!.ensure(existing));
        } catch (e) {
          deps.io.info(`✗ ${redactErr(e)}`);
        }
      }
      const conn = await getValidatedConnection(deps.io, deps.connect, {
        savedUrl: existing.postgresUrl, trySavedSilently: true, interactive: deps.options?.yes !== true,
      });
      const localDb = existing.localDb && new URL(conn.url).host === new URL(existing.postgresUrl).host ? existing.localDb : undefined;
      await finalize(deps, conn.pool, { ...existing, postgresUrl: conn.url, localDb });
      return;
    }
  }
  await runWizard(deps, existing);
}

async function runWizard(deps: Deps, existing: Config | undefined): Promise<void> {
  const quick = !existing && (await deps.io.select({
    message: "Setup",
    initialValue: "quick",
    options: [
      { value: "quick", label: "Quick", hint: "recommended — sensible defaults, no more questions" },
      { value: "custom", label: "Custom", hint: "choose the database, namespace, capture mode, embeddings, and CLIs" },
    ],
  })) === "quick";
  const { conn, localDb } = await chooseDatabase(deps, existing, quick);
  if (quick) {
    const detected = detectClients(deps.home, deps.which);
    const clients = [...new Set(["claude", ...detected])].filter((k) => clientByKey(k));
    const namespace = deps.defaultNamespace || "default";
    deps.io.info(`Using namespace "${namespace}", automatic capture, full-text search, and: ${clients.map((k) => clientByKey(k)!.title).join(", ")}. Re-run memhub init to change any of this.`);
    await finalize(deps, conn.pool, {
      postgresUrl: conn.url, namespace, captureMode: "auto", embeddings: { provider: "none" }, clients, localDb,
    });
    return;
  }
  const nsAnswer = (await deps.io.text({ message: "Namespace (shared across machines)", defaultValue: existing?.namespace ?? deps.defaultNamespace })).trim();
  const namespace = nsAnswer || existing?.namespace || deps.defaultNamespace || "default";
  const captureMode = (await deps.io.select({
    message: "Capture mode",
    initialValue: existing?.captureMode ?? "auto",
    options: [
      { value: "auto", label: "Auto", hint: "memory is recalled and updated on its own, no asking (recommended)" },
      { value: "manual", label: "Manual", hint: "save only when you ask" },
    ],
  })) as "auto" | "manual";
  const embeddings = await promptEmbeddings(deps.io, conn.hasVector, existing?.embeddings);
  const clients = await promptClients(deps, existing);
  await finalize(deps, conn.pool, { postgresUrl: conn.url, namespace, captureMode, embeddings, clients, dreamCommand: existing?.dreamCommand, localDb });
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
  async multiselect(opts) {
    const v = await p.multiselect({
      message: opts.message,
      options: opts.options,
      initialValues: opts.initialValues,
      required: false,
    });
    if (p.isCancel(v)) { p.cancel("Aborted."); process.exit(1); }
    return (v as string[]) ?? [];
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

const autoIO: InitIO = {
  async text(opts) { return opts.defaultValue ?? ""; },
  async select(opts) { return opts.initialValue ?? opts.options[0].value; },
  async multiselect(opts) { return opts.initialValues ?? []; },
  async password() { return ""; },
  async confirm(opts) { return opts.initialValue ?? true; },
  async step(message, fn) {
    try { const r = await fn(); console.log(`✓ ${message}`); return r; }
    catch (e) { console.log(`✗ ${message}`); throw e; }
  },
  info(message) { console.log(message); },
};

export function installedOutsideNpx(run: (file: string, args: string[]) => string = (f, a) => execFileSync(f, a, { encoding: "utf8" })): boolean {
  try {
    return run("which", ["-a", "memhub"])
      .split("\n").map((l) => l.trim()).filter(Boolean)
      .some((path) => !path.includes("/_npx/") && !path.includes("node_modules/.bin"));
  } catch {
    return false;
  }
}

export function resolveMemhubCommand(
  onPath: () => boolean = installedOutsideNpx,
  globalBin: () => string = () => join(execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim(), "bin", "memhub"),
  exists: (path: string) => boolean = existsSync
): string | null {
  if (onPath()) return "memhub";
  try {
    const path = globalBin();
    return exists(path) ? path : null;
  } catch {
    return null;
  }
}

export function parseInitArgs(args: string[]): { yes: boolean; url?: string } {
  const i = args.indexOf("--url");
  return { yes: args.includes("--yes") || args.includes("-y"), url: i >= 0 ? args[i + 1] : undefined };
}

const NEXT_STEPS = [
  "Restart your AI CLIs so they pick up memhub.",
  "Work as usual. Memory fills in on its own after each session — you never have to say \"remember this\".",
  "memhub doctor checks the setup · memhub stats shows what is stored · memhub init changes settings.",
];

export function runInit(args: string[] = []): void {
  const options = parseInitArgs(args);
  (async () => {
    if (!options.yes) {
      p.intro("memhub — a personal memory for your AI CLIs");
      p.note("This sets up a database for your memory, connects your AI CLIs to it,\nand turns on automatic recall and learning. It takes about a minute.", "What happens");
    }
    await runInitWith({
      io: options.yes ? autoIO : realIO,
      connect: async (url) => new Pool({ connectionString: url }),
      configDir: join(homedir(), ".memhub"),
      home: homedir(),
      defaultNamespace: safeUsername(),
      local: { supported: localSupported, setup: setupLocalDb, ensure: ensureLocalDb },
      selfInstall: {
        needed: () => resolveMemhubCommand() === null,
        install: () => { execFileSync("npm", ["install", "-g", `memhub@${VERSION}`], { stdio: "ignore" }); },
      },
      command: resolveMemhubCommand,
      options,
    });
    if (options.yes) console.log("\nDone.\n" + NEXT_STEPS.map((l, i) => `  ${i + 1}. ${l}`).join("\n"));
    else {
      p.note(NEXT_STEPS.map((l, i) => `${i + 1}. ${l}`).join("\n"), "Next");
      p.outro("Done.");
    }
  })().catch((err) => {
    const msg = `Error: ${redactUrl(err instanceof Error ? err.message : String(err))}`;
    if (options.yes) console.error(msg);
    else p.cancel(msg);
    process.exit(1);
  });
}

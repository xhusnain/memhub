import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { runInitWith, installedOutsideNpx, installNeeded, memhubPaths, parseInitArgs, resolveMemhubCommand, type InitIO } from "../src/wizard/init.js";
import { VERSION } from "../src/version.js";
import { saveConfig } from "../src/config.js";

let container: StartedPostgreSqlContainer;
let uri: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  uri = container.getConnectionUri();
});
afterAll(async () => { await container.stop(); });

function makeIO(opts: {
  connQueue: string[];
  namespace?: string;
  capture: "auto" | "manual";
  embeddings: "none" | "openai" | "ollama" | "cloudflare";
  clients?: string[];
  texts?: Record<string, string>;
  passwords?: Record<string, string>;
  selects?: Record<string, string>;
  action?: "keep" | "reconfigure";
  confirmAnswers?: Record<string, boolean>;
  setup?: "quick" | "custom";
  where?: "local" | "url";
}) {
  const infos: string[] = [];
  const io: InitIO = {
    async text(o) {
      if (o.message.includes("Postgres connection string")) return opts.connQueue.shift() ?? "";
      if (o.message.includes("Namespace")) return opts.namespace ?? o.defaultValue ?? "";
      for (const k of Object.keys(opts.texts ?? {})) if (o.message.includes(k)) return opts.texts![k];
      return o.defaultValue ?? "";
    },
    async select(o) {
      if (o.message.includes("Found existing config")) return opts.action ?? "keep";
      if (o.message === "Setup") return opts.setup ?? "custom";
      if (o.message.includes("Where should memory be stored")) return opts.where ?? "url";
      if (o.message.includes("Capture mode")) return opts.capture;
      if (o.message.includes("Embeddings provider")) return opts.embeddings;
      for (const k of Object.keys(opts.selects ?? {})) if (o.message.includes(k)) return opts.selects![k];
      return o.options[0].value;
    },
    async multiselect(o) {
      return opts.clients ?? o.initialValues ?? [];
    },
    async password(o) {
      for (const k of Object.keys(opts.passwords ?? {})) if (o.message.includes(k)) return opts.passwords![k];
      return "secret";
    },
    async confirm(o) {
      for (const k of Object.keys(opts.confirmAnswers ?? {})) if (o.message.includes(k)) return opts.confirmAnswers![k];
      return o.initialValue ?? true;
    },
    async step(_m, fn) { return fn(); },
    info(m) { infos.push(m); },
  };
  return { io, infos };
}

function makeDeps(base: string) {
  const home = join(base, "home");
  const configDir = join(base, "cfg");
  const runs: Array<[string, string[]]> = [];
  return {
    home,
    configDir,
    runs,
    deps: {
      connect: async (u: string) => new Pool({ connectionString: u, connectionTimeoutMillis: 1500 }),
      configDir,
      home,
      run: (f: string, a: string[]) => { runs.push([f, a]); },
      which: () => false,
    },
  };
}

const CLAUDE_PAIR = [
  ["claude", ["mcp", "remove", "--scope", "user", "memhub"]],
  ["claude", ["mcp", "add", "--scope", "user", "memhub", "-e", "MEMHUB_CLIENT=claude", "--", "memhub", "serve"]],
];

const claudeCalls = (runs: Array<[string, string[]]>) => runs.filter(([f]) => f === "claude");

describe("runInitWith (improved wizard)", () => {
  it("validates the connection, then sets up with none/auto and registers claude", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { home, configDir, runs, deps } = makeDeps(base);
    const { io, infos } = makeIO({ connQueue: [uri], namespace: "husnain", capture: "auto", embeddings: "none" });

    await runInitWith({ io, ...deps });

    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.namespace).toBe("husnain");
    expect(cfg.captureMode).toBe("auto");
    expect(cfg.embeddings.provider).toBe("none");
    expect(cfg.clients).toEqual(["claude"]);
    expect(claudeCalls(runs)).toEqual(CLAUDE_PAIR);
    expect(runs).toContainEqual(["codex", ["mcp", "remove", "memhub"]]);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toMatch(/auto-capture START/);
    expect(infos.some((m) => /connected/i.test(m))).toBe(true);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe("memhub hook prompt");
    expect(infos.some((m) => /hooks installed/i.test(m))).toBe(true);

    const pool = new Pool({ connectionString: uri });
    expect((await pool.query("select to_regclass('public.memories') as t")).rows[0].t).toBe("memories");
    await pool.end();
  });

  it("retries when the first connection string fails, then succeeds", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    const { io, infos } = makeIO({ connQueue: ["postgres://bad:bad@127.0.0.1:1/none", uri], namespace: "h", capture: "manual", embeddings: "none" });
    await runInitWith({ io, ...deps });
    expect(infos.some((m) => /could not connect/i.test(m))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.namespace).toBe("h");
  });

  it("registers multiple chosen clients and installs the snippet into each instructions file", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { home, configDir, runs, deps } = makeDeps(base);
    const { io } = makeIO({ connQueue: [uri], namespace: "h", capture: "auto", embeddings: "none", clients: ["claude", "gemini", "opencode"] });

    await runInitWith({ io, ...deps });

    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.clients).toEqual(["claude", "gemini", "opencode"]);
    expect(claudeCalls(runs)).toEqual(CLAUDE_PAIR);
    const gemini = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    expect(gemini.mcpServers.memhub.command).toBe("memhub");
    const opencode = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
    expect(opencode.mcp.memhub.command).toEqual(["memhub", "serve"]);
    expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).toMatch(/memhub/);
    expect(readFileSync(join(home, ".config", "opencode", "AGENTS.md"), "utf8")).toMatch(/memhub/);
  });

  it("a failing client registration does not abort the others", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { home, deps } = makeDeps(base);
    deps.run = (f: string) => { if (f === "claude") throw new Error("claude broke"); };
    const { io, infos } = makeIO({ connQueue: [uri], namespace: "h", capture: "auto", embeddings: "none", clients: ["claude", "gemini"] });

    await runInitWith({ io, ...deps });

    expect(infos.some((m) => m.includes("✗ Claude Code"))).toBe(true);
    expect(infos.some((m) => m.includes("✓ Gemini CLI"))).toBe(true);
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
  });

  it("cloudflare: saves provider and runs the embeddings migration", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    const { io } = makeIO({
      connQueue: [uri], namespace: "h", capture: "auto", embeddings: "cloudflare",
      texts: { "account ID": "acc123" },
      selects: { "Cloudflare embedding model": "@cf/baai/bge-base-en-v1.5" },
      passwords: { "API token": "cf-token" },
    });
    await runInitWith({ io, ...deps });

    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.embeddings).toEqual({ provider: "cloudflare", model: "@cf/baai/bge-base-en-v1.5", accountId: "acc123", apiToken: "cf-token" });
    const pool = new Pool({ connectionString: uri });
    expect((await pool.query("select to_regclass('public.memory_embeddings') as t")).rows[0].t).toBe("memory_embeddings");
    await pool.end();
  });

  it("ollama: saves model and baseUrl and runs the embeddings migration", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    const { io } = makeIO({
      connQueue: [uri], namespace: "h", capture: "auto", embeddings: "ollama",
      texts: { "Ollama embedding model": "nomic-embed-text", "Ollama base URL": "http://localhost:11434" },
    });
    await runInitWith({ io, ...deps });
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.embeddings).toEqual({ provider: "ollama", model: "nomic-embed-text", baseUrl: "http://localhost:11434" });
  });

  it("keep & re-apply: existing config, no re-prompting, migration + registration run", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { home, configDir, runs, deps } = makeDeps(base);
    saveConfig({ postgresUrl: uri, namespace: "saved-ns", captureMode: "auto", embeddings: { provider: "none" } }, configDir);
    const { io } = makeIO({ connQueue: [], capture: "auto", embeddings: "none", action: "keep" });
    await runInitWith({ io, ...deps });
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.namespace).toBe("saved-ns");
    expect(cfg.clients).toEqual(["claude"]);
    expect(claudeCalls(runs)).toEqual(CLAUDE_PAIR);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toMatch(/auto-capture START/);
  });

  it("deselecting a client de-registers it and strips its instruction block", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { home, deps } = makeDeps(base);
    const { io: firstIo } = makeIO({ connQueue: [uri], namespace: "h", capture: "auto", embeddings: "none", clients: ["claude", "gemini"] });
    await runInitWith({ io: firstIo, ...deps });
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.memhub).toBeDefined();
    expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).toMatch(/auto-capture START/);

    const { io: secondIo } = makeIO({ connQueue: [], capture: "auto", embeddings: "none", action: "reconfigure", clients: ["claude"] });
    secondIo.text = async (o) => o.message.includes("Postgres connection string") ? uri : (o.defaultValue ?? "");
    await runInitWith({ io: secondIo, ...deps });
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.memhub).toBeUndefined();
    expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).not.toMatch(/auto-capture START/);
  });

  it("reconfigure: reuses the existing API key without re-typing", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    saveConfig({ postgresUrl: uri, namespace: "n", captureMode: "auto", embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-existing" } }, configDir);
    const { io } = makeIO({
      connQueue: [uri], capture: "auto", embeddings: "openai", action: "reconfigure",
      confirmAnswers: { "Reuse the existing OpenAI API key": true },
    });
    await runInitWith({ io, ...deps });
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.embeddings.apiKey).toBe("sk-existing");
  });

  it("manual capture mode removes the claude hooks an earlier auto setup installed", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { home, deps } = makeDeps(base);
    const auto = makeIO({ connQueue: [uri], namespace: "husnain", capture: "auto", embeddings: "none" });
    await runInitWith({ io: auto.io, ...deps });
    const path = join(home, ".claude", "settings.json");
    expect(JSON.parse(readFileSync(path, "utf8")).hooks.SessionEnd).toBeDefined();
    const manual = makeIO({ connQueue: [uri], namespace: "husnain", capture: "manual", embeddings: "none", action: "reconfigure" });
    await runInitWith({ io: manual.io, ...deps });
    expect(JSON.parse(readFileSync(path, "utf8")).hooks).toBeUndefined();
  });
});

describe("easy onboarding", () => {
  const fakeLocal = (calls: string[], ok = true) => ({
    supported: () => true,
    setup: async (baseDir: string) => {
      calls.push(`setup:${baseDir}`);
      if (!ok) throw new Error("download failed");
      return { postgresUrl: uri, localDb: { port: 54329, dataDir: join(baseDir, "pgdata"), binDir: join(baseDir, "pg", "bin") } };
    },
    ensure: async () => { calls.push("ensure"); },
  });

  it("quick setup asks nothing else: local database, auto capture, detected CLIs", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { home, configDir, deps } = makeDeps(base);
    const calls: string[] = [];
    const asked: string[] = [];
    const { io, infos } = makeIO({ connQueue: [], capture: "manual", embeddings: "openai", setup: "quick" });
    const text = io.text.bind(io);
    io.text = async (o) => { asked.push(o.message); return text(o); };
    await runInitWith({ io, ...deps, defaultNamespace: "sam", local: fakeLocal(calls) });

    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg).toMatchObject({ postgresUrl: uri, namespace: "sam", captureMode: "auto", embeddings: { provider: "none" }, clients: ["claude"] });
    expect(cfg.localDb.port).toBe(54329);
    expect(calls).toEqual([`setup:${configDir}`]);
    expect(asked).toEqual([]);
    expect(infos.some((m) => /Local database ready/.test(m))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.SessionStart).toBeDefined();
  });

  it("custom setup offers the local database or your own Postgres", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    const calls: string[] = [];
    const url = makeIO({ connQueue: [uri], namespace: "sam", capture: "auto", embeddings: "none", where: "url" });
    await runInitWith({ io: url.io, ...deps, local: fakeLocal(calls) });
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).localDb).toBeUndefined();

    const local = makeIO({ connQueue: [], namespace: "sam", capture: "auto", embeddings: "none", where: "local", action: "reconfigure" });
    await runInitWith({ io: local.io, ...deps, local: fakeLocal(calls) });
    expect(calls).toEqual([`setup:${configDir}`]);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).localDb).toBeDefined();
  });

  it("falls back to asking for a URL when the local database cannot be set up", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    const { io, infos } = makeIO({ connQueue: [uri], capture: "auto", embeddings: "none", setup: "quick" });
    await runInitWith({ io, ...deps, local: fakeLocal([], false) });
    expect(infos.some((m) => /could not be set up: download failed/.test(m))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.postgresUrl).toBe(uri);
    expect(cfg.localDb).toBeUndefined();
  });

  it("keep & re-apply starts the local database first and keeps it in the config", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    const calls: string[] = [];
    const first = makeIO({ connQueue: [], capture: "auto", embeddings: "none", setup: "quick" });
    await runInitWith({ io: first.io, ...deps, local: fakeLocal(calls) });
    const again = makeIO({ connQueue: [], capture: "auto", embeddings: "none", action: "keep" });
    await runInitWith({ io: again.io, ...deps, local: fakeLocal(calls) });
    expect(calls).toEqual([`setup:${configDir}`, "ensure"]);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).localDb.port).toBe(54329);
  });

  it("installs memhub itself when started through npx, and says how if the user declines", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { deps } = makeDeps(base);
    let installs = 0;
    const selfInstall = { needed: () => true, install: () => { installs++; } };
    const yes = makeIO({ connQueue: [uri], capture: "auto", embeddings: "none" });
    await runInitWith({ io: yes.io, ...deps, selfInstall });
    expect(installs).toBe(1);

    const no = makeIO({ connQueue: [], capture: "auto", embeddings: "none", action: "keep", confirmAnswers: { "Install memhub": false } });
    await runInitWith({ io: no.io, ...deps, selfInstall });
    expect(installs).toBe(1);
    expect(no.infos.some((m) => /npm install -g memhub/.test(m))).toBe(true);

    const failing = makeIO({ connQueue: [], capture: "auto", embeddings: "none", action: "keep" });
    await runInitWith({ io: failing.io, ...deps, selfInstall: { needed: () => true, install: () => { throw new Error("EACCES"); } } });
    expect(failing.infos.some((m) => /Install failed: EACCES/.test(m))).toBe(true);

    const present = makeIO({ connQueue: [], capture: "auto", embeddings: "none", action: "keep" });
    await runInitWith({ io: present.io, ...deps, selfInstall: { needed: () => false, install: () => { installs++; } } });
    expect(installs).toBe(1);
  });

  it("registers every CLI and hook with the full path when memhub is not on PATH", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { home, runs, deps } = makeDeps(base);
    const bin = "/opt/node/bin/memhub";
    const { io, infos } = makeIO({ connQueue: [uri], capture: "auto", embeddings: "none", clients: ["claude", "codex", "gemini", "cursor", "opencode"] });
    await runInitWith({ io, ...deps, command: () => bin });
    expect(infos.some((m) => m.includes(`will start memhub from ${bin}`))).toBe(true);
    expect(runs).toContainEqual(["claude", ["mcp", "add", "--scope", "user", "memhub", "-e", "MEMHUB_CLIENT=claude", "--", bin, "serve"]]);
    expect(runs).toContainEqual(["codex", ["mcp", "add", "memhub", "--env", "MEMHUB_CLIENT=codex", "--", bin, "serve"]]);
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.memhub.command).toBe(bin);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.memhub.command).toBe(bin);
    expect(JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8")).mcp.memhub.command).toEqual([bin, "serve"]);
    const hooks = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks;
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(`${bin} hook prompt`);
  });

  it("keep & re-apply moves a saved Neon pooled URL to the direct one", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    const pooled = "postgresql://u:p@ep-cool-dawn-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
    saveConfig({ postgresUrl: pooled, namespace: "sam", captureMode: "manual", embeddings: { provider: "none" }, clients: [] }, configDir);
    const seen: string[] = [];
    const { io, infos } = makeIO({ connQueue: [], capture: "manual", embeddings: "none", action: "keep" });
    await runInitWith({ io, ...deps, connect: async (u: string) => { seen.push(u); return new Pool({ connectionString: uri }); } });
    expect(seen[0]).toBe("postgresql://u:p@ep-cool-dawn-123456.us-east-2.aws.neon.tech/neondb?sslmode=verify-full");
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).postgresUrl).toBe(seen[0]);
    expect(infos.some((m) => /switched from the pooled connection/.test(m))).toBe(true);
  });

  it("--url uses that database without asking, even over an existing config", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { configDir, deps } = makeDeps(base);
    const calls: string[] = [];
    const { io } = makeIO({ connQueue: [], capture: "auto", embeddings: "none", setup: "quick" });
    await runInitWith({ io, ...deps, local: fakeLocal(calls), options: { yes: true, url: uri } });
    expect(calls).toEqual([]);
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.postgresUrl).toBe(uri);
    expect(cfg.localDb).toBeUndefined();
  });

  it("fails clearly instead of looping when --yes has no database to use", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { deps } = makeDeps(base);
    const { io } = makeIO({ connQueue: [], capture: "auto", embeddings: "none", setup: "quick" });
    await expect(runInitWith({ io, ...deps, options: { yes: true } })).rejects.toThrow(/--url/);
    await expect(runInitWith({ io, ...deps, options: { yes: true, url: "postgres://nobody:x@127.0.0.1:1/none" } })).rejects.toThrow();
  });
});

describe("init helpers", () => {
  it("parses --yes and --url", () => {
    expect(parseInitArgs([])).toEqual({ yes: false, url: undefined });
    expect(parseInitArgs(["-y"])).toEqual({ yes: true, url: undefined });
    expect(parseInitArgs(["--yes", "--url", "postgres://x"])).toEqual({ yes: true, url: "postgres://x" });
  });

  it("does not count the npx cache or a project-local bin as an installed memhub", () => {
    expect(installedOutsideNpx(() => "/Users/x/.npm/_npx/abc123/node_modules/.bin/memhub\n")).toBe(false);
    expect(installedOutsideNpx(() => "/repo/node_modules/.bin/memhub\n")).toBe(false);
    expect(installedOutsideNpx(() => "/Users/x/.npm/_npx/abc/node_modules/.bin/memhub\n/opt/homebrew/bin/memhub\n")).toBe(true);
    expect(installedOutsideNpx(() => { throw new Error("not found"); })).toBe(false);
  });

  it("always resolves memhub to a full path: PATH first, then npm's global folder, else nothing", () => {
    expect(resolveMemhubCommand(() => ["/usr/local/bin/memhub", "/other/memhub"])).toBe("/usr/local/bin/memhub");
    expect(resolveMemhubCommand(() => [], () => "/g/bin/memhub", () => true)).toBe("/g/bin/memhub");
    expect(resolveMemhubCommand(() => [], () => "/g/bin/memhub", () => false)).toBeNull();
    expect(resolveMemhubCommand(() => [], () => { throw new Error("no npm"); })).toBeNull();
  });

  it("installs when memhub is missing, outdated, or too old to report a version", () => {
    expect(installNeeded(null)).toBe(true);
    expect(installNeeded("/g/bin/memhub", "0.4.3", () => "0.4.3\n")).toBe(false);
    expect(installNeeded("/g/bin/memhub", "0.4.3", () => "0.4.1\n")).toBe(true);
    expect(installNeeded("/g/bin/memhub", "0.4.3", () => "Usage: memhub <init|serve|dream|schedule>\n")).toBe(true);
    expect(installNeeded("/g/bin/memhub", "0.4.3", () => { throw new Error("exit 1"); })).toBe(true);
  });

  it("is not fooled by the folders npx adds to PATH while it runs", () => {
    const underNpx = () => "/Users/x/.npm/_npx/abc/node_modules/.bin/memhub\n/Users/x/.local/share/node/v24/bin/memhub\n";
    expect(memhubPaths(underNpx)).toEqual(["/Users/x/.local/share/node/v24/bin/memhub"]);
    expect(resolveMemhubCommand(() => memhubPaths(underNpx))).toBe("/Users/x/.local/share/node/v24/bin/memhub");
    expect(memhubPaths(() => "memhub not found\n")).toEqual([]);
  });

  it("keeps the version constant in step with package.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version);
  });
});

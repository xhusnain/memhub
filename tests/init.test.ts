import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { runInitWith, type InitIO } from "../src/wizard/init.js";
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
  ["claude", ["mcp", "add", "--scope", "user", "--env", "MEMHUB_CLIENT=claude", "memhub", "--", "memhub", "serve"]],
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
});

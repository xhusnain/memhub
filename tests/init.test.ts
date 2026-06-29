import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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

describe("runInitWith (improved wizard)", () => {
  it("validates the connection, then sets up with none/auto", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const configDir = join(base, "cfg");
    const claudeMdPath = join(base, "claude", "CLAUDE.md");
    const calls: Array<[string, string[]]> = [];
    const { io, infos } = makeIO({ connQueue: [uri], namespace: "husnain", capture: "auto", embeddings: "none" });

    await runInitWith({ io, connect: async (u) => new Pool({ connectionString: u }), configDir, claudeMdPath, registerMcp: (c, a) => calls.push([c, a]) });

    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.namespace).toBe("husnain");
    expect(cfg.captureMode).toBe("auto");
    expect(cfg.embeddings.provider).toBe("none");
    expect(calls).toEqual([["memhub", ["serve"]]]);
    expect(readFileSync(claudeMdPath, "utf8")).toMatch(/auto-capture START/);
    expect(infos.some((m) => /connected/i.test(m))).toBe(true);

    const pool = new Pool({ connectionString: uri });
    expect((await pool.query("select to_regclass('public.memories') as t")).rows[0].t).toBe("memories");
    await pool.end();
  });

  it("retries when the first connection string fails, then succeeds", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const { io, infos } = makeIO({ connQueue: ["postgres://bad:bad@127.0.0.1:1/none", uri], namespace: "h", capture: "manual", embeddings: "none" });
    await runInitWith({
      io,
      connect: async (u) => new Pool({ connectionString: u, connectionTimeoutMillis: 1500 }),
      configDir: join(base, "cfg"), claudeMdPath: join(base, "claude", "CLAUDE.md"), registerMcp: () => {},
    });
    expect(infos.some((m) => /could not connect/i.test(m))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(base, "cfg", "config.json"), "utf8"));
    expect(cfg.namespace).toBe("h");
  });

  it("cloudflare: saves provider and runs the embeddings migration", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const configDir = join(base, "cfg");
    const { io } = makeIO({
      connQueue: [uri], namespace: "h", capture: "auto", embeddings: "cloudflare",
      texts: { "account ID": "acc123" },
      selects: { "Cloudflare embedding model": "@cf/baai/bge-base-en-v1.5" },
      passwords: { "API token": "cf-token" },
    });
    await runInitWith({ io, connect: async (u) => new Pool({ connectionString: u }), configDir, claudeMdPath: join(base, "claude", "CLAUDE.md"), registerMcp: () => {} });

    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.embeddings).toEqual({ provider: "cloudflare", model: "@cf/baai/bge-base-en-v1.5", accountId: "acc123", apiToken: "cf-token" });
    const pool = new Pool({ connectionString: uri });
    expect((await pool.query("select to_regclass('public.memory_embeddings') as t")).rows[0].t).toBe("memory_embeddings");
    await pool.end();
  });

  it("ollama: saves model and baseUrl and runs the embeddings migration", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const configDir = join(base, "cfg");
    const { io } = makeIO({
      connQueue: [uri], namespace: "h", capture: "auto", embeddings: "ollama",
      texts: { "Ollama embedding model": "nomic-embed-text", "Ollama base URL": "http://localhost:11434" },
    });
    await runInitWith({ io, connect: async (u) => new Pool({ connectionString: u }), configDir, claudeMdPath: join(base, "claude", "CLAUDE.md"), registerMcp: () => {} });
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.embeddings).toEqual({ provider: "ollama", model: "nomic-embed-text", baseUrl: "http://localhost:11434" });
  });

  it("keep & re-apply: existing config, no re-prompting, migration + registration run", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const configDir = join(base, "cfg");
    const claudeMdPath = join(base, "claude", "CLAUDE.md");
    saveConfig({ postgresUrl: uri, namespace: "saved-ns", captureMode: "auto", embeddings: { provider: "none" } }, configDir);
    const calls: Array<[string, string[]]> = [];
    // connQueue empty: "keep" must NOT prompt for a URL (it uses the saved one silently)
    const { io } = makeIO({ connQueue: [], capture: "auto", embeddings: "none", action: "keep" });
    await runInitWith({ io, connect: async (u) => new Pool({ connectionString: u }), configDir, claudeMdPath, registerMcp: (c, a) => calls.push([c, a]) });
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.namespace).toBe("saved-ns");           // unchanged
    expect(calls).toEqual([["memhub", ["serve"]]]);
    const pool = new Pool({ connectionString: uri });
    expect((await pool.query("select to_regclass('public.memories') as t")).rows[0].t).toBe("memories");
    await pool.end();
  });

  it("reconfigure: reuses the existing API key without re-typing", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const configDir = join(base, "cfg");
    saveConfig({ postgresUrl: uri, namespace: "n", captureMode: "auto", embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-existing" } }, configDir);
    const { io } = makeIO({
      connQueue: [uri], capture: "auto", embeddings: "openai", action: "reconfigure",
      confirmAnswers: { "Reuse the existing OpenAI API key": true },
    });
    await runInitWith({ io, connect: async (u) => new Pool({ connectionString: u }), configDir, claudeMdPath: join(base, "claude", "CLAUDE.md"), registerMcp: () => {} });
    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.embeddings.apiKey).toBe("sk-existing");   // reused, not re-prompted
  });
});

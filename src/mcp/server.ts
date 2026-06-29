import { Pool } from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { migrate } from "../db/migrate.js";
import { migrateEmbeddings } from "../db/migrate-embeddings.js";
import { MemoryStore, type Memory } from "../db/store.js";
import { loadConfig } from "../config.js";
import { createEmbedder } from "../embeddings/registry.js";
import { redactUrl } from "../redact.js";
import { maybeAutoDream } from "../dream.js";

function fmt(m: Memory): string {
  const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  return `• ${m.content}${tags} (${m.level}, ${m.kind ?? "note"}, conf ${m.confidence}, confirmed ${m.last_confirmed_at.slice(0, 10)}, id ${m.id})`;
}

const guard = (fn: () => Promise<string>) =>
  fn().catch((e) => `Error: ${redactUrl(e instanceof Error ? e.message : String(e))}`);

export function buildToolHandlers(store: MemoryStore) {
  return {
    async remember(a: { content: string; kind?: string; tags?: string[]; source?: string; confidence?: number; level?: string }) {
      return guard(async () => {
        const m = await store.remember(a);
        return `Remembered: ${fmt(m)}`;
      });
    },
    async recall(a: { query: string; k?: number }) {
      return guard(async () => {
        const hits = await store.recall(a.query, a.k);
        return hits.length ? hits.map(fmt).join("\n") : "No memories found.";
      });
    },
    async list(a: { kind?: string; status?: string }) {
      return guard(async () => {
        const all = await store.list(a);
        return all.length ? all.map(fmt).join("\n") : "No memories.";
      });
    },
    async forget(a: { id: string }) {
      return guard(async () =>
        (await store.forget(a.id)) ? `Forgot ${a.id}.` : `No memory ${a.id}.`
      );
    },
    async confirm(a: { id: string }) {
      return guard(async () =>
        (await store.confirm(a.id)) ? `Confirmed ${a.id}.` : `No memory ${a.id}.`
      );
    },
    async supersede(a: { id: string; content: string }) {
      return guard(async () => {
        const m = await store.supersede(a.id, a.content);
        return `Superseded ${a.id} → ${fmt(m)}`;
      });
    },
    async review(a: { days?: number; k?: number }) {
      return guard(async () => {
        const hits = await store.stale(a.days ?? 30, a.k);
        return hits.length ? hits.map(fmt).join("\n") : "No stale memories.";
      });
    },
    history: (a: { id: string }) =>
      guard(async () => {
        const chain = await store.history(a.id);
        return chain.length ? chain.map(fmt).join("\n") : `No memory ${a.id}.`;
      }),
  };
}

export async function serve(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.postgresUrl });
  await migrate(pool);
  const embedder = createEmbedder(cfg.embeddings);
  if (embedder) await migrateEmbeddings(pool);
  const store = new MemoryStore(pool, cfg.namespace, embedder ?? undefined);
  // Honcho-style: dreaming is automatic ONLY in auto mode. In manual mode the
  // user drives everything (remember/forget) and nothing runs on its own.
  if (cfg.captureMode === "auto") {
    try {
      const res = await maybeAutoDream(store);
      if (res.triggered) console.error("memhub: background reasoning dream started");
    } catch {
      // best-effort — never block serve startup
    }
  }
  const handlers = buildToolHandlers(store);
  const server = new McpServer({ name: "memhub", version: "0.1.0" });

  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  server.registerTool("remember", {
    description: "Store a distilled fact in long-term memory.",
    inputSchema: {
      content: z.string(), kind: z.string().optional(), tags: z.array(z.string()).optional(),
      source: z.string().optional(), confidence: z.number().min(0).max(1).optional(),
      level: z.enum(["explicit", "deductive", "inductive"]).optional(),
    },
  }, async (a) => text(await handlers.remember(a)));

  server.registerTool("recall", {
    description: "Search long-term memory by full text.",
    inputSchema: { query: z.string(), k: z.number().int().positive().optional() },
  }, async (a) => text(await handlers.recall(a)));

  server.registerTool("list", {
    description: "List/audit stored memories.",
    inputSchema: { kind: z.string().optional(), status: z.string().optional() },
  }, async (a) => text(await handlers.list(a)));

  server.registerTool("forget", {
    description: "Archive a memory by id.",
    inputSchema: { id: z.string() },
  }, async (a) => text(await handlers.forget(a)));

  server.registerTool("confirm", {
    description: "Mark a memory as still true (refresh freshness).",
    inputSchema: { id: z.string() },
  }, async (a) => text(await handlers.confirm(a)));

  server.registerTool("supersede", {
    description: "Replace an outdated memory with a corrected one.",
    inputSchema: { id: z.string(), content: z.string() },
  }, async (a) => text(await handlers.supersede(a)));

  server.registerTool("review", {
    description: "List memories not confirmed recently that may be stale. Review each and confirm, supersede, or forget it to keep memory honest.",
    inputSchema: { days: z.number().int().positive().optional(), k: z.number().int().positive().optional() },
  }, async (a) => text(await handlers.review(a)));

  server.registerTool("history", {
    description: "Show how a memory evolved — its chain of superseded versions, newest to oldest.",
    inputSchema: { id: z.string() },
  }, async (a) => text(await handlers.history(a)));

  await server.connect(new StdioServerTransport());

  const shutdown = () => { pool.end().finally(() => process.exit(0)); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

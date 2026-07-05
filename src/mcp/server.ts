import { Pool } from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { migrate } from "../db/migrate.js";
import { migrateEmbeddings } from "../db/migrate-embeddings.js";
import { MemoryStore, type Memory } from "../db/store.js";
import { loadConfig } from "../config.js";
import { createEmbedder } from "../embeddings/registry.js";
import { redactErr } from "../redact.js";
import { maybeAutoDream } from "../dream.js";

function fmt(m: Memory): string {
  const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  const observed = m.observed_at ? `, observed ${m.observed_at.slice(0, 10)}` : "";
  const via = m.client ? `, via ${m.client}` : "";
  return `• ${m.content}${tags} (${m.level}, ${m.kind ?? "note"}, conf ${m.confidence}, sal ${m.salience}${observed}${via}, confirmed ${m.last_confirmed_at.slice(0, 10)}, id ${m.id.slice(0, 8)})`;
}

const guard = (fn: () => Promise<string>) =>
  fn().catch((e) => `Error: ${redactErr(e)}`);

export function buildToolHandlers(store: MemoryStore) {
  return {
    async remember(a: {
      content: string; kind?: string; tags?: string[]; source?: string;
      confidence?: number; level?: string; salience?: number;
      observed_at?: string; expires_at?: string;
    }) {
      return guard(async () => {
        const res = await store.remember({
          content: a.content, kind: a.kind, tags: a.tags, source: a.source,
          confidence: a.confidence, level: a.level, salience: a.salience,
          observedAt: a.observed_at, expiresAt: a.expires_at,
        });
        if (res.deduped) return `Already known (confirmed instead): ${fmt(res.memory)}`;
        const lines = [`Remembered: ${fmt(res.memory)}`];
        if (res.similar.length) {
          lines.push("Similar existing memories — if any states the same fact, supersede or confirm it instead of keeping both:");
          for (const s of res.similar) lines.push(fmt(s));
        }
        return lines.join("\n");
      });
    },
    async recall(a: { query: string; k?: number }) {
      return guard(async () => {
        const hits = await store.recall(a.query, a.k);
        return hits.length ? hits.map(fmt).join("\n") : "No memories found.";
      });
    },
    async context() {
      return guard(async () => {
        const c = await store.context();
        const parts: string[] = [];
        if (c.peerCard) parts.push(`PEER CARD:\n${c.peerCard.content}`);
        if (c.top.length) parts.push(`KEY MEMORIES:\n${c.top.map(fmt).join("\n")}`);
        if (c.recent.length) parts.push(`RECENT:\n${c.recent.map(fmt).join("\n")}`);
        return parts.length ? parts.join("\n\n") : "No memories yet.";
      });
    },
    async list(a: { kind?: string; status?: string; client?: string }) {
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
  const server = new McpServer({ name: "memhub", version: "0.3.0" });
  const store = new MemoryStore(
    pool,
    cfg.namespace,
    embedder ?? undefined,
    () => process.env.MEMHUB_CLIENT ?? server.server.getClientVersion()?.name ?? null
  );
  if (cfg.captureMode === "auto") {
    try {
      const res = await maybeAutoDream(store);
      if (res.triggered) console.error("memhub: background reasoning dream started");
    } catch {}
  }
  const handlers = buildToolHandlers(store);

  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  server.registerTool("remember", {
    description: "Store a distilled fact in long-term memory. Write it self-contained (no pronouns), with absolute dates (never 'yesterday'), keeping concrete specifics (names, versions, counts). Record transitions with the old state ('switched from X to Y because Z'). Store content, not meta-facts about the conversation. salience 0-1 = how much future sessions need this. If the result lists similar existing memories, reconcile them: supersede or confirm instead of keeping duplicates.",
    inputSchema: {
      content: z.string(), kind: z.string().optional(), tags: z.array(z.string()).optional(),
      source: z.string().optional(), confidence: z.number().min(0).max(1).optional(),
      level: z.enum(["explicit", "deductive", "inductive"]).optional(),
      salience: z.number().min(0).max(1).optional(),
      observed_at: z.string().optional(), expires_at: z.string().optional(),
    },
  }, async (a) => text(await handlers.remember(a)));

  server.registerTool("recall", {
    description: "Search long-term memory (hybrid full-text + semantic; ranked by relevance, recency, and salience).",
    inputSchema: { query: z.string(), k: z.number().int().positive().optional() },
  }, async (a) => text(await handlers.recall(a)));

  server.registerTool("context", {
    description: "Load session context from long-term memory: the peer-card identity summary plus the most salient and recent facts. Call once at the start of a session.",
    inputSchema: {},
  }, async () => text(await handlers.context()));

  server.registerTool("list", {
    description: "List/audit stored memories, optionally by kind, status, or source client.",
    inputSchema: { kind: z.string().optional(), status: z.string().optional(), client: z.string().optional() },
  }, async (a) => text(await handlers.list(a)));

  server.registerTool("forget", {
    description: "Archive a memory by id. Accepts full or 8-char short ids.",
    inputSchema: { id: z.string() },
  }, async (a) => text(await handlers.forget(a)));

  server.registerTool("confirm", {
    description: "Mark a memory as still true (refresh freshness, raise confidence). Accepts full or 8-char short ids.",
    inputSchema: { id: z.string() },
  }, async (a) => text(await handlers.confirm(a)));

  server.registerTool("supersede", {
    description: "Replace an outdated memory with a corrected one. Keep the version with more information. Accepts full or 8-char short ids.",
    inputSchema: { id: z.string(), content: z.string() },
  }, async (a) => text(await handlers.supersede(a)));

  server.registerTool("review", {
    description: "List memories not confirmed recently that may be stale. Review each and confirm, supersede, or forget it to keep memory honest.",
    inputSchema: { days: z.number().int().positive().optional(), k: z.number().int().positive().optional() },
  }, async (a) => text(await handlers.review(a)));

  server.registerTool("history", {
    description: "Show how a memory evolved — its chain of superseded versions, newest to oldest. Accepts full or 8-char short ids.",
    inputSchema: { id: z.string() },
  }, async (a) => text(await handlers.history(a)));

  await server.connect(new StdioServerTransport());

  const shutdown = () => { pool.end().finally(() => process.exit(0)); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

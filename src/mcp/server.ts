import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { migrate } from "../db/migrate.js";
import { migrateEmbeddings } from "../db/migrate-embeddings.js";
import { MemoryStore } from "../db/store.js";
import { loadConfig } from "../config.js";
import { createEmbedder } from "../embeddings/registry.js";
import { redactErr } from "../redact.js";
import { maybeAutoDream } from "../dream.js";
import { fmt, fmtBrief, fmtRecall } from "../format.js";
import { projectKey, projectScope } from "../project.js";
import { openPool } from "../localdb.js";
import { VERSION } from "../version.js";

function resolveScope(scope: string | undefined, project: string | null | undefined): string | undefined {
  if (!scope) return undefined;
  const s = scope.trim().toLowerCase();
  if (s === "project") return projectScope(project) ?? "global";
  if (s === "global" || s.startsWith("project:")) return s;
  return undefined;
}

const guard = (fn: () => Promise<string>) =>
  fn().catch((e) => `Error: ${redactErr(e)}`);

export function buildToolHandlers(store: MemoryStore, project?: string | null) {
  return {
    async remember(a: {
      content: string; kind?: string; tags?: string[]; source?: string;
      confidence?: number; level?: string; salience?: number;
      observed_at?: string; expires_at?: string; scope?: string; links?: string[];
    }) {
      return guard(async () => {
        const res = await store.remember({
          content: a.content, kind: a.kind, tags: a.tags, source: a.source,
          confidence: a.confidence, level: a.level, salience: a.salience,
          observedAt: a.observed_at, expiresAt: a.expires_at,
          scope: resolveScope(a.scope, project), links: a.links,
        });
        if (res.deduped) return `Already known (confirmed instead): ${fmt(res.memory)}`;
        const lines = [`Remembered: ${fmt(res.memory)}`];
        if (res.similar.length) {
          lines.push("Similar existing memories — if one states the same fact, confirm it; if the new fact replaces it (both cannot be true), supersede it with a reason; if both are true and connected, link them:");
          for (const s of res.similar) lines.push(fmt(s));
        }
        return lines.join("\n");
      });
    },
    async recall(a: { query: string; k?: number; deep?: boolean }) {
      return guard(async () => {
        const hits = await store.recall(a.query, a.k, { project, deep: a.deep });
        return hits.length ? hits.map(fmtRecall).join("\n") : "No memories found.";
      });
    },
    async context() {
      return guard(async () => {
        const c = await store.context(project);
        const parts: string[] = [];
        if (c.peerCard) parts.push(`PEER CARD:\n${c.peerCard.content}`);
        if (c.top.length) parts.push(`KEY MEMORIES:\n${c.top.map(fmtBrief).join("\n")}`);
        if (c.recent.length) parts.push(`RECENT:\n${c.recent.map(fmtBrief).join("\n")}`);
        return parts.length ? parts.join("\n\n") : "No memories yet.";
      });
    },
    async list(a: { kind?: string; status?: string; client?: string; scope?: string; since?: string; limit?: number; offset?: number }) {
      return guard(async () => {
        const offset = a.offset ?? 0;
        const page = await store.listPage({ ...a, scope: resolveScope(a.scope, project), offset });
        if (!page.memories.length) return "No memories.";
        const lines = page.memories.map(fmt);
        const end = offset + page.memories.length;
        if (end < page.total) lines.push(`Showing ${offset + 1}–${end} of ${page.total}. Call list again with offset ${end} for more.`);
        return lines.join("\n");
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
    async supersede(a: { id: string; content: string; reason?: string }) {
      return guard(async () => {
        const m = await store.supersede(a.id, a.content, a.reason);
        return `Superseded ${a.id} → ${fmt(m)}`;
      });
    },
    async link(a: { a: string; b: string; relation?: string }) {
      return guard(async () =>
        (await store.link(a.a, a.b, a.relation)) ? `Linked ${a.a} ↔ ${a.b}.` : `Could not link ${a.a} and ${a.b}.`
      );
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
        if (!chain.length) return `No memory ${a.id}.`;
        const lines = chain.map(fmt);
        const links = await store.linksOf(chain[0].id);
        if (links.length) {
          lines.push("LINKED:");
          for (const l of links) lines.push(`${l.relation}: ${fmtBrief(l.memory)}`);
        }
        return lines.join("\n");
      }),
  };
}

export async function serve(): Promise<void> {
  const cfg = loadConfig();
  const pool = await openPool(cfg.postgresUrl);
  await migrate(pool);
  const embedder = createEmbedder(cfg.embeddings);
  if (embedder) await migrateEmbeddings(pool);
  const server = new McpServer({ name: "memhub", version: VERSION });
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
  const project = process.env.MEMHUB_PROJECT !== undefined
    ? process.env.MEMHUB_PROJECT.trim() || null
    : projectKey(process.cwd());
  const handlers = buildToolHandlers(store, project);

  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  server.registerTool("remember", {
    description: "Store a distilled fact in long-term memory. Write it self-contained (no pronouns), with absolute dates (never 'yesterday'), keeping concrete specifics (names, versions, counts) and the situation it applies to ('for Remotion videos, ...'). Store content, not meta-facts about the conversation. kind: preference | procedure | fact | decision | episode. scope: 'global' (how the user works everywhere, the default) or 'project' (true only in the current project). salience 0-1 = how much future sessions need this. confidence below 0.5 marks a tentative inference that is kept but not auto-injected until confirmed. links = ids of related memories. If the result lists similar existing memories, reconcile them.",
    inputSchema: {
      content: z.string(), kind: z.string().optional(), tags: z.array(z.string()).optional(),
      source: z.string().optional(), confidence: z.number().min(0).max(1).optional(),
      level: z.enum(["explicit", "deductive", "inductive"]).optional(),
      salience: z.number().min(0).max(1).optional(),
      observed_at: z.string().optional(), expires_at: z.string().optional(),
      scope: z.string().optional(), links: z.array(z.string()).optional(),
    },
  }, async (a) => text(await handlers.remember(a)));

  server.registerTool("recall", {
    description: "Search long-term memory (hybrid full-text + semantic, plus memories linked to the best hits; ranked by relevance, retention, salience, and project). A result marked [was: ...] shows the value it replaced and when. deep=true also searches faded memories and revives the ones it returns.",
    inputSchema: { query: z.string(), k: z.number().int().positive().optional(), deep: z.boolean().optional() },
  }, async (a) => text(await handlers.recall(a)));

  server.registerTool("context", {
    description: "Load session context from long-term memory: the peer-card identity summary plus the most salient and recent facts. Call once at the start of a session.",
    inputSchema: {},
  }, async () => text(await handlers.context()));

  server.registerTool("list", {
    description: "List/audit stored memories, newest first, 100 per page. Filter by kind, status (active | superseded | archived | faded), source client, scope, or since (ISO timestamp, created after). Use offset to page.",
    inputSchema: {
      kind: z.string().optional(), status: z.string().optional(), client: z.string().optional(),
      scope: z.string().optional(), since: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(), offset: z.number().int().min(0).optional(),
    },
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
    description: "Replace a memory whose value changed with the new value — only when both cannot be true at once. The old version is kept as history and shown as [was: ...] in recall. reason = why it changed, in a few words. Accepts full or 8-char short ids.",
    inputSchema: { id: z.string(), content: z.string(), reason: z.string().optional() },
  }, async (a) => text(await handlers.supersede(a)));

  server.registerTool("link", {
    description: "Connect two memories that are both true and belong together (same topic, cause and effect, a rule and its example). Recall follows links one step, so linked memories surface together. relation is a short label such as related, example_of, derived_from, summarizes, from_episode.",
    inputSchema: { a: z.string(), b: z.string(), relation: z.string().optional() },
  }, async (a) => text(await handlers.link(a)));

  server.registerTool("review", {
    description: "List memories not confirmed recently that may be stale. Review each and confirm, supersede, or forget it to keep memory honest.",
    inputSchema: { days: z.number().int().positive().optional(), k: z.number().int().positive().optional() },
  }, async (a) => text(await handlers.review(a)));

  server.registerTool("history", {
    description: "Show how a memory evolved — its chain of superseded versions, newest to oldest — and the memories linked to it. Accepts full or 8-char short ids.",
    inputSchema: { id: z.string() },
  }, async (a) => text(await handlers.history(a)));

  await server.connect(new StdioServerTransport());

  const shutdown = () => { pool.end().finally(() => process.exit(0)); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

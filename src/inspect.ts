import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { MemoryStore } from "./db/store.js";
import { createEmbedder } from "./embeddings/registry.js";
import { buildToolHandlers } from "./mcp/server.js";
import { projectKey } from "./project.js";
import { pendingSessions } from "./reflect.js";
import { redactErr } from "./redact.js";
import { openPool } from "./localdb.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(args: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    out.push(args[i]);
  }
  return out.join(" ");
}

function table(title: string, counts: Record<string, number>): string {
  const rows = Object.entries(counts).map(([k, n]) => `  ${k.padEnd(24)} ${n}`);
  return `${title}\n${rows.length ? rows.join("\n") : "  (none)"}`;
}

export const INSPECT_COMMANDS = ["recall", "list", "history", "stats"];

export async function runInspect(command: string, args: string[]): Promise<void> {
  const cfg = loadConfig();
  const pool = await openPool(cfg.postgresUrl);
  try {
    await migrate(pool);
    const store = new MemoryStore(pool, cfg.namespace, createEmbedder(cfg.embeddings) ?? undefined, () => "cli");
    const h = buildToolHandlers(store, projectKey(process.cwd()));
    const num = (name: string) => (flag(args, name) ? Number(flag(args, name)) : undefined);
    let out: string;
    if (command === "recall") {
      out = await h.recall({ query: positional(args), k: num("k"), deep: args.includes("--deep") || undefined });
    } else if (command === "list") {
      out = await h.list({
        kind: flag(args, "kind"), status: flag(args, "status") ?? "active", client: flag(args, "client"),
        scope: flag(args, "scope"), since: flag(args, "since"), limit: num("limit"), offset: num("offset"),
      });
    } else if (command === "history") {
      out = await h.history({ id: positional(args) });
    } else {
      const s = await store.stats();
      out = [
        `namespace ${cfg.namespace}`,
        table("BY STATUS", s.byStatus),
        table("ACTIVE BY KIND", s.byKind),
        table("ACTIVE BY SCOPE", s.byScope),
        `links ${s.links}`,
        `sessions waiting for reflection ${pendingSessions().length}`,
      ].join("\n\n");
    }
    console.log(out);
  } catch (e) {
    console.error(redactErr(e));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

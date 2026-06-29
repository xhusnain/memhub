import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const START = "<!-- memhub:auto-capture START -->";
const END = "<!-- memhub:auto-capture END -->";

const SNIPPET = `## Long-term memory (memhub)

Proactively maintain long-term memory using the memhub MCP tools, without being asked:
- At the start of relevant work, \`recall\` what you already know about the topic.
- Before saving, \`recall\` for a similar existing fact: if one exists, \`supersede\` it (replace) or \`confirm\` it (still true) instead of adding a duplicate — only \`remember\` genuinely new facts. Record where each came from (source).
- When the user contradicts a remembered fact or it goes out of date, \`supersede\` it; when something is no longer true, \`forget\` it.
- Use \`review\` to surface stale memories and reconcile each one. Use \`history\` to see how a fact evolved.
- Keep memories concise and factual. Never save secrets or transient details.`;

function stripBlock(text: string): string {
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s === -1 || e === -1 || e < s) return text;
  const before = text.slice(0, s).replace(/\n+$/, "");
  const after = text.slice(e + END.length).replace(/^\n+/, "");
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

export function applyCaptureSnippet(claudeMdPath: string, mode: "auto" | "manual"): void {
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";

  if (mode === "manual") {
    if (!existsSync(claudeMdPath)) return; // don't create a file just to have nothing to remove
    const stripped = stripBlock(existing);
    writeFileSync(claudeMdPath, stripped.trim() ? `${stripped.replace(/\n+$/, "")}\n` : "");
    return;
  }

  const base = stripBlock(existing).replace(/\n+$/, "");
  const block = `${START}\n${SNIPPET}\n${END}`;
  const next = base ? `${base}\n\n${block}\n` : `${block}\n`;
  mkdirSync(dirname(claudeMdPath), { recursive: true });
  writeFileSync(claudeMdPath, next);
}

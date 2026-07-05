import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const START = "<!-- memhub:auto-capture START -->";
const END = "<!-- memhub:auto-capture END -->";

const SNIPPET = `## Long-term memory (memhub)

One shared long-term memory across all AI CLIs and machines, via the memhub MCP tools. Maintain it proactively, without being asked:
- Call \`context\` once at the start of a session to load the peer-card and key facts; \`recall\` before starting work on any topic.
- Before saving, \`recall\` for a similar existing fact: \`supersede\` it (replace), \`confirm\` it (still true), or skip — only \`remember\` genuinely new facts. When a remember result lists similar existing memories, reconcile them immediately.
- Write self-contained facts with absolute dates (never "yesterday"/"last week"), keep concrete specifics (names, versions, counts), and record transitions with the old state ("switched from X to Y because Z").
- Set \`salience\` 0-1 (how much future sessions need this), \`source\` (where it came from), \`observed_at\` for when the fact was true, and \`expires_at\` for transient facts.
- When the user contradicts a fact, \`supersede\` it; when it stops being true, \`forget\` it. Use \`review\` to reconcile stale memories and \`history\` to see how a fact evolved.
- Prefer memhub over any built-in per-CLI memory (MEMORY.md, save_memory, # shortcuts) so every tool shares one brain. Never save secrets or transient noise.`;

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
    if (!existsSync(claudeMdPath)) return;
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

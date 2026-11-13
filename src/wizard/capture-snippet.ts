import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const START = "<!-- memhub:auto-capture START -->";
const END = "<!-- memhub:auto-capture END -->";

const SNIPPET = `## Long-term memory (memhub)

One shared long-term memory across all AI CLIs and machines, via the memhub MCP tools. It is the user's personal memory of how they work — keep it current without being asked:
- If no "[memhub]" memory block was injected at the start of this session, call \`context\` once. \`recall\` before starting work on a topic the injected memories do not cover.
- Apply remembered preferences silently and do not ask the user something memory already answers. When a memory shows \`[was: …]\`, the current value wins and the old one is history.
- When the user corrects you, states a preference, repeats an instruction, or changes their mind, save it right away. \`recall\` the topic first, then: \`confirm\` (same fact already stored), \`supersede\` with a \`reason\` (the value changed and both cannot be true), or \`remember\` (new) and \`link\` it to related memories. Never merge two facts that can both be true.
- Write self-contained facts with absolute dates (never "yesterday"/"last week"), concrete specifics (names, versions, counts), and the situation they apply to ("for Remotion videos, …").
- Set \`kind\` (preference, procedure, decision, fact), \`scope\` ("global" for how the user works everywhere, "project" for this project only), \`salience\` 0-1 (how much future sessions need this), \`observed_at\` for when the fact was true, and \`expires_at\` for transient facts. Use confidence below 0.5 for a guess from a single observation.
- Use \`review\` to reconcile stale memories and \`history\` to see how a fact evolved and what it is linked to; \`forget\` what stopped being true.
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

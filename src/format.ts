import type { Memory } from "./db/store.js";

function day(ts: string | null | undefined): string {
  return ts ? ts.slice(0, 10) : "";
}

export function trail(m: Memory): string {
  if (!m.previous) return "";
  const until = m.previous.superseded_at ? ` until ${day(m.previous.superseded_at)}` : "";
  const why = m.previous.reason ? ` — ${m.previous.reason}` : "";
  return ` [was: "${m.previous.content}"${until}${why}]`;
}

function scopeTag(m: Memory): string {
  return m.scope && m.scope !== "global" ? `, ${m.scope}` : "";
}

export function fmtBrief(m: Memory): string {
  return `• ${m.content}${trail(m)} (id ${m.id.slice(0, 8)})`;
}

export function fmtRecall(m: Memory): string {
  return `• ${m.content}${trail(m)} (${m.kind ?? "note"}${scopeTag(m)}, confirmed ${day(m.last_confirmed_at)}, id ${m.id.slice(0, 8)})`;
}

export function fmt(m: Memory): string {
  const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
  const observed = m.observed_at ? `, observed ${day(m.observed_at)}` : "";
  const via = m.client ? `, via ${m.client}` : "";
  const status = m.status !== "active" ? `, ${m.status}` : "";
  return `• ${m.content}${tags}${trail(m)} (${m.level}, ${m.kind ?? "note"}${scopeTag(m)}${status}, conf ${m.confidence}, sal ${m.salience}${observed}${via}, confirmed ${day(m.last_confirmed_at)}, id ${m.id.slice(0, 8)})`;
}

export function withinBudget(lines: string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

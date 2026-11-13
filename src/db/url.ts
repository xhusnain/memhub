export type UrlAdjustment = { url: string; notes: string[] };

const NEON_HOST = /\.neon\.(tech|com)$/i;

export function adjustPostgresUrl(raw: string): UrlAdjustment {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { url: raw.trim(), notes: [] }; }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !NEON_HOST.test(u.hostname)) return { url: raw.trim(), notes: [] };
  const notes: string[] = [];
  const labels = u.hostname.split(".");
  if (labels[0].endsWith("-pooler")) {
    labels[0] = labels[0].slice(0, -"-pooler".length);
    u.hostname = labels.join(".");
    notes.push("Neon: switched from the pooled connection to the direct one — memhub's background passes rely on session locks, which transaction pooling does not keep.");
  }
  if (u.searchParams.get("sslmode") === "require") u.searchParams.set("sslmode", "verify-full");
  return { url: u.toString(), notes };
}

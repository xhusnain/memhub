export function redactUrl(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"`,<>()[\]]+/gi, "postgres://***redacted***");
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.message) return e.message;
  const inner = (e as { errors?: unknown }).errors;
  if (Array.isArray(inner) && inner.length) {
    const codes = [...new Set(inner.map((x) => (x as { code?: string })?.code ?? (x instanceof Error ? x.message : String(x))))];
    return `could not connect (${codes.join(", ")})`;
  }
  return (e as { code?: string }).code ?? e.name ?? "unknown error";
}

export function redactErr(e: unknown): string {
  return redactUrl(describe(e));
}

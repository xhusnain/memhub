export function redactUrl(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"`,<>()[\]]+/gi, "postgres://***redacted***");
}

export function redactErr(e: unknown): string {
  return redactUrl(e instanceof Error ? e.message : String(e));
}

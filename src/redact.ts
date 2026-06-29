// Replace any postgres/postgresql connection string with a safe placeholder so
// credentials never reach logs or error output.
export function redactUrl(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"`,<>()[\]]+/gi, "postgres://***redacted***");
}

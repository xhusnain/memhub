import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const EmbeddingsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("none") }),
  z.object({ provider: z.literal("openai"), model: z.string().min(1), apiKey: z.string().min(1), baseUrl: z.string().optional() }),
  z.object({ provider: z.literal("ollama"), model: z.string().min(1), baseUrl: z.string().optional() }),
  z.object({ provider: z.literal("cloudflare"), model: z.string().min(1), accountId: z.string().min(1), apiToken: z.string().min(1), baseUrl: z.string().optional() }),
]);

const ConfigSchema = z.object({
  postgresUrl: z.string().min(1),
  namespace: z.string().min(1),
  captureMode: z.enum(["auto", "manual"]),
  embeddings: EmbeddingsSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

export function configPath(baseDir = join(homedir(), ".memhub")): string {
  return join(baseDir, "config.json");
}

export function saveConfig(c: Config, baseDir?: string): void {
  const p = configPath(baseDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ConfigSchema.parse(c), null, 2));
}

export function loadConfig(baseDir?: string): Config {
  const p = configPath(baseDir);
  if (!existsSync(p)) {
    throw new Error(`Config not found at ${p}. Run 'memhub init' first.`);
  }
  const result = ConfigSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid config at ${p}: ${issues}. Re-run 'memhub init'.`);
  }
  return result.data;
}

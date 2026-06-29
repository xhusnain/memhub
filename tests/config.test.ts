import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, loadConfig, configPath } from "../src/config.js";

describe("config (global)", () => {
  it("round-trips a config through a base dir, creating it", () => {
    const base = join(mkdtempSync(join(tmpdir(), "cm-")), "nested");
    const cfg = { postgresUrl: "postgres://x", namespace: "husnain", captureMode: "auto" as const, embeddings: { provider: "none" as const } };
    saveConfig(cfg, base);
    expect(loadConfig(base)).toEqual(cfg);
    expect(configPath(base)).toBe(join(base, "config.json"));
  });

  it("throws a clear error when missing", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    expect(() => loadConfig(base)).toThrow(/not found.*memhub init/i);
  });

  it("round-trips an openai embeddings config", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const cfg = { postgresUrl: "postgres://x", namespace: "h", captureMode: "auto" as const,
      embeddings: { provider: "openai" as const, model: "text-embedding-3-small", apiKey: "sk" } };
    saveConfig(cfg, base);
    expect(loadConfig(base)).toEqual(cfg);
  });

  it("throws a clear error when the config is invalid", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "config.json"), JSON.stringify({ namespace: "x" }));
    expect(() => loadConfig(base)).toThrow(/invalid config.*memhub init/i);
  });
});

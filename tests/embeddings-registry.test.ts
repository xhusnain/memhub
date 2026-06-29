import { describe, it, expect } from "vitest";
import { createEmbedder } from "../src/embeddings/registry.js";

describe("createEmbedder", () => {
  it("returns null for none", () => {
    expect(createEmbedder({ provider: "none" })).toBeNull();
  });
  it("builds an openai embedder", () => {
    const e = createEmbedder({ provider: "openai", model: "text-embedding-3-small", apiKey: "x" });
    expect(e?.provider).toBe("openai");
    expect(e?.dim).toBe(1536);
  });
  it("builds an ollama embedder", () => {
    const e = createEmbedder({ provider: "ollama", model: "nomic-embed-text" });
    expect(e?.provider).toBe("ollama");
    expect(e?.dim).toBe(768);
  });
  it("builds a cloudflare embedder", () => {
    const e = createEmbedder({ provider: "cloudflare", model: "@cf/baai/bge-base-en-v1.5", accountId: "a", apiToken: "t" });
    expect(e?.provider).toBe("cloudflare");
    expect(e?.dim).toBe(768);
  });
});

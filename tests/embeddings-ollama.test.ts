import { describe, it, expect } from "vitest";
import { ollamaEmbedder } from "../src/embeddings/ollama.js";

describe("ollamaEmbedder", () => {
  it("posts to /api/embed and parses the embeddings array", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => ({ embeddings: [[1, 2, 3], [4, 5, 6]] }) } as any;
    }) as unknown as typeof fetch;

    const e = ollamaEmbedder({ model: "nomic-embed-text", fetchImpl });
    expect(e.provider).toBe("ollama");
    expect(e.dim).toBe(768);

    const out = await e.embed(["a", "b"]);
    expect(out).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(calls[0].url).toBe("http://localhost:11434/api/embed");
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) } as any)) as unknown as typeof fetch;
    const e = ollamaEmbedder({ model: "nomic-embed-text", fetchImpl });
    await expect(e.embed(["a"])).rejects.toThrow(/ollama.*500/i);
  });
});

import { describe, it, expect } from "vitest";
import { openaiEmbedder } from "../src/embeddings/openai.js";

describe("openaiEmbedder", () => {
  it("posts to the embeddings endpoint with auth and parses vectors", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }) } as any;
    }) as unknown as typeof fetch;

    const e = openaiEmbedder({ model: "text-embedding-3-small", apiKey: "sk-test", fetchImpl });
    expect(e.provider).toBe("openai");
    expect(e.dim).toBe(1536);

    const out = await e.embed(["a", "b"]);
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(calls[0].url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0].init.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] });
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429, json: async () => ({}) } as any)) as unknown as typeof fetch;
    const e = openaiEmbedder({ model: "text-embedding-3-small", apiKey: "x", fetchImpl });
    await expect(e.embed(["a"])).rejects.toThrow(/openai.*429/i);
  });
});

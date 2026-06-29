import { describe, it, expect } from "vitest";
import { cloudflareEmbedder } from "../src/embeddings/cloudflare.js";

describe("cloudflareEmbedder", () => {
  it("posts to the CF AI endpoint and parses result.data", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({ result: { data: [[1, 2, 3], [4, 5, 6]] }, success: true }),
      } as any;
    }) as unknown as typeof fetch;

    const e = cloudflareEmbedder({
      model: "@cf/baai/bge-base-en-v1.5",
      accountId: "ACC",
      apiToken: "TOKEN",
      fetchImpl,
    });
    expect(e.provider).toBe("cloudflare");
    expect(e.dim).toBe(768);

    const out = await e.embed(["a", "b"]);
    expect(out).toEqual([[1, 2, 3], [4, 5, 6]]);

    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/ACC/ai/run/@cf/baai/bge-base-en-v1.5"
    );
    expect(calls[0].init.headers["authorization"]).toBe("Bearer TOKEN");
    expect(JSON.parse(calls[0].init.body)).toEqual({ text: ["a", "b"] });
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    } as any)) as unknown as typeof fetch;
    const e = cloudflareEmbedder({
      model: "@cf/baai/bge-base-en-v1.5",
      accountId: "ACC",
      apiToken: "TOKEN",
      fetchImpl,
    });
    await expect(e.embed(["a"])).rejects.toThrow(/cloudflare.*403/i);
  });

  it("uses dim lookup for bge-small (384)", () => {
    const e = cloudflareEmbedder({
      model: "@cf/baai/bge-small-en-v1.5",
      accountId: "ACC",
      apiToken: "TOKEN",
    });
    expect(e.dim).toBe(384);
  });

  it("uses dim lookup for bge-large (1024)", () => {
    const e = cloudflareEmbedder({
      model: "@cf/baai/bge-large-en-v1.5",
      accountId: "ACC",
      apiToken: "TOKEN",
    });
    expect(e.dim).toBe(1024);
  });
});

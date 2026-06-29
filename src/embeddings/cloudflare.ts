import type { Embedder, FetchFn } from "./types.js";

const CF_DIMS: Record<string, number> = {
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
};

export function cloudflareEmbedder(opts: {
  model: string;
  accountId: string;
  apiToken: string;
  baseUrl?: string;
  dim?: number;
  fetchImpl?: FetchFn;
}): Embedder {
  const base = opts.baseUrl ?? "https://api.cloudflare.com/client/v4";
  const dim = opts.dim ?? CF_DIMS[opts.model] ?? 768;
  const f: FetchFn = opts.fetchImpl ?? fetch;
  return {
    provider: "cloudflare",
    model: opts.model,
    dim,
    async embed(texts) {
      const url = `${base}/accounts/${opts.accountId}/ai/run/${opts.model}`;
      const res = await f(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${opts.apiToken}`,
        },
        body: JSON.stringify({ text: texts }),
      });
      if (!res.ok) throw new Error(`Cloudflare embeddings failed: ${res.status}`);
      const json = (await res.json()) as { result: { data: number[][] }; success: boolean };
      return json.result.data;
    },
  };
}

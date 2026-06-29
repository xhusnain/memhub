import type { Embedder, FetchFn } from "./types.js";

const OPENAI_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export function openaiEmbedder(opts: {
  model: string; apiKey: string; baseUrl?: string; dim?: number; fetchImpl?: FetchFn;
}): Embedder {
  const base = opts.baseUrl ?? "https://api.openai.com/v1";
  const dim = opts.dim ?? OPENAI_DIMS[opts.model] ?? 1536;
  const f: FetchFn = opts.fetchImpl ?? fetch;
  return {
    provider: "openai",
    model: opts.model,
    dim,
    async embed(texts) {
      const res = await f(`${base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: opts.model, input: texts }),
      });
      if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data.map((d) => d.embedding);
    },
  };
}

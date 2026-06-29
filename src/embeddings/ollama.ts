import type { Embedder, FetchFn } from "./types.js";

const OLLAMA_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "bge-m3": 1024,
};

export function ollamaEmbedder(opts: {
  model: string; baseUrl?: string; dim?: number; fetchImpl?: FetchFn;
}): Embedder {
  const base = opts.baseUrl ?? "http://localhost:11434";
  const dim = opts.dim ?? OLLAMA_DIMS[opts.model] ?? 768;
  const f: FetchFn = opts.fetchImpl ?? fetch;
  return {
    provider: "ollama",
    model: opts.model,
    dim,
    async embed(texts) {
      const res = await f(`${base}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, input: texts }),
      });
      if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`);
      const json = (await res.json()) as { embeddings: number[][] };
      return json.embeddings;
    },
  };
}

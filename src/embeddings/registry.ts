import type { Config } from "../config.js";
import type { Embedder, FetchFn } from "./types.js";
import { openaiEmbedder } from "./openai.js";
import { ollamaEmbedder } from "./ollama.js";
import { cloudflareEmbedder } from "./cloudflare.js";

export function createEmbedder(cfg: Config["embeddings"], fetchImpl?: FetchFn): Embedder | null {
  switch (cfg.provider) {
    case "none": return null;
    case "openai": return openaiEmbedder({ model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, fetchImpl });
    case "ollama": return ollamaEmbedder({ model: cfg.model, baseUrl: cfg.baseUrl, fetchImpl });
    case "cloudflare": return cloudflareEmbedder({ model: cfg.model, accountId: cfg.accountId, apiToken: cfg.apiToken, baseUrl: cfg.baseUrl, fetchImpl });
  }
}

export interface Embedder {
  provider: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
export type FetchFn = typeof fetch;

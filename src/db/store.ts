import type { Pool, PoolClient } from "pg";
import type { Embedder } from "../embeddings/types.js";

export type Memory = {
  id: string; namespace: string; content: string; kind: string | null;
  tags: string[]; source: string | null; confidence: number;
  level: string; status: string; salience: number; client: string | null;
  observed_at: string | null; expires_at: string | null; access_count: number;
  created_at: string; last_confirmed_at: string;
};

export type RememberInput = {
  content: string; kind?: string; tags?: string[]; source?: string;
  confidence?: number; level?: string; salience?: number;
  observedAt?: string; expiresAt?: string;
};

export type RememberResult = { memory: Memory; deduped: boolean; similar: Memory[] };

export type ContextResult = { peerCard: Memory | null; top: Memory[]; recent: Memory[] };

const COL_LIST = [
  "id", "namespace", "content", "kind", "tags", "source", "confidence", "level", "status",
  "salience", "client", "observed_at::text as observed_at", "expires_at::text as expires_at",
  "access_count", "created_at::text as created_at", "last_confirmed_at::text as last_confirmed_at",
];
const COLS = COL_LIST.join(", ");
const COLS_M = COL_LIST.map((c) => "m." + c).join(", ");

const FRESH = "(expires_at is null or expires_at > now())";
const FRESH_M = "(m.expires_at is null or m.expires_at > now())";

const SIMILAR_K = 3;
const SIMILAR_MAX_DISTANCE = 0.5;
const SIMILAR_MIN_RANK = 0.02;
const RECENCY_FLOOR = 0.7;
const RECENCY_SPAN = 0.3;
const RECENCY_HALF_DAYS = 90;
const SALIENCE_FLOOR = 0.75;
const CONTEXT_TOP = 12;
const CONTEXT_RECENT = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX_RE = /^[0-9a-f][0-9a-f-]{5,35}$/;

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function rrfCandidates(lists: Memory[][]): { memory: Memory; rrf: number }[] {
  const score = new Map<string, number>();
  const byId = new Map<string, Memory>();
  for (const list of lists) {
    list.forEach((m, rank) => {
      byId.set(m.id, m);
      score.set(m.id, (score.get(m.id) ?? 0) + 1 / (60 + rank));
    });
  }
  return [...byId.values()].map((m) => ({ memory: m, rrf: score.get(m.id)! }));
}

function recencyBoost(lastConfirmedAt: string): number {
  const t = Date.parse(lastConfirmedAt);
  if (!Number.isFinite(t)) return RECENCY_FLOOR + RECENCY_SPAN;
  const days = Math.max(0, (Date.now() - t) / 86400000);
  return RECENCY_FLOOR + RECENCY_SPAN * Math.exp(-days / RECENCY_HALF_DAYS);
}

function salienceBoost(salience: number): number {
  return SALIENCE_FLOOR + 0.5 * salience;
}

export class MemoryStore {
  constructor(
    private pool: Pool,
    private namespace: string,
    private embedder?: Embedder,
    private client?: () => string | null
  ) {}

  private async upsertMemory(
    exec: Pool | PoolClient,
    input: RememberInput
  ): Promise<{ memory: Memory; inserted: boolean }> {
    const { rows } = await exec.query(
      `insert into memories (namespace, content, kind, tags, source, confidence, level, salience, client, observed_at, expires_at)
       values ($1,$2,$3,$4,$5,coalesce($6::real, 0.7),$7,coalesce($8::real, 0.5),$9,$10,$11)
       on conflict (namespace, content_hash) where status = 'active' do update set
         last_confirmed_at = now(),
         confidence = least(1.0, coalesce($6::real, memories.confidence + 0.1)),
         salience = coalesce($8::real, memories.salience),
         kind = coalesce(excluded.kind, memories.kind),
         tags = case when excluded.tags <> '{}' then excluded.tags else memories.tags end,
         source = coalesce(excluded.source, memories.source),
         observed_at = coalesce(excluded.observed_at, memories.observed_at),
         expires_at = excluded.expires_at
       returning ${COLS}, (xmax::text = '0') as inserted`,
      [this.namespace, input.content, input.kind ?? null, input.tags ?? [],
       input.source ?? null, input.confidence ?? null, input.level ?? "explicit",
       input.salience ?? null, this.client?.() ?? null, input.observedAt ?? null, input.expiresAt ?? null]
    );
    const { inserted, ...memory } = rows[0];
    return { memory: memory as Memory, inserted };
  }

  private async storeEmbedding(memoryId: string, vec: number[]): Promise<void> {
    if (!this.embedder) return;
    await this.pool.query(
      `insert into memory_embeddings (memory_id, provider, model, dim, embedding)
       values ($1,$2,$3,$4,$5::vector)
       on conflict (memory_id, provider, model) do update set embedding = excluded.embedding`,
      [memoryId, this.embedder.provider, this.embedder.model, this.embedder.dim, toVectorLiteral(vec)]
    );
  }

  private async ensureEmbedding(memory: Memory): Promise<void> {
    if (!this.embedder) return;
    try {
      const { rows } = await this.pool.query(
        `select 1 from memory_embeddings where memory_id=$1 and provider=$2 and model=$3`,
        [memory.id, this.embedder.provider, this.embedder.model]
      );
      if (rows.length) return;
      const [vec] = await this.embedder.embed([memory.content]);
      await this.storeEmbedding(memory.id, vec);
    } catch {}
  }

  async resolveId(idOrPrefix: string): Promise<string | null> {
    const s = idOrPrefix.trim().toLowerCase();
    if (UUID_RE.test(s)) return s;
    if (!PREFIX_RE.test(s)) return null;
    const { rows } = await this.pool.query(
      `select id from memories where namespace=$1 and id::text like $2 order by id limit 6`,
      [this.namespace, s + "%"]
    );
    if (rows.length > 1) {
      throw new Error(`Ambiguous memory id ${idOrPrefix} — matches: ${rows.map((r) => r.id).join(", ")}`);
    }
    return rows[0]?.id ?? null;
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const { memory, inserted } = await this.upsertMemory(this.pool, input);
    if (!inserted) {
      await this.ensureEmbedding(memory);
      return { memory, deduped: true, similar: [] };
    }
    let vec: number[] | undefined;
    if (this.embedder) {
      try {
        [vec] = await this.embedder.embed([memory.content]);
      } catch {
        vec = undefined;
      }
    }
    const [similar] = await Promise.all([
      this.similarTo(memory, vec),
      vec ? this.storeEmbedding(memory.id, vec).catch(() => {}) : Promise.resolve(),
    ]);
    return { memory, deduped: false, similar };
  }

  private async similarTo(memory: Memory, vec?: number[]): Promise<Memory[]> {
    try {
      if (vec && this.embedder) {
        const { rows } = await this.pool.query(
          `select ${COLS_M}
           from memories m join memory_embeddings e on e.memory_id = m.id
           where m.namespace=$1 and m.status='active' and m.id <> $2
             and e.provider=$3 and e.model=$4 and e.dim=$5 and ${FRESH_M}
             and (e.embedding <=> $6::vector) <= ${SIMILAR_MAX_DISTANCE}
           order by e.embedding <=> $6::vector limit ${SIMILAR_K}`,
          [this.namespace, memory.id, this.embedder.provider, this.embedder.model, this.embedder.dim, toVectorLiteral(vec)]
        );
        return rows;
      }
      if (!memory.content.trim()) return [];
      const { rows } = await this.pool.query(
        `with q as (
           select to_tsquery('english', replace(plainto_tsquery('english', $2)::text, ' & ', ' | ')) as tq
         )
         select ${COLS_M}, ts_rank(m.fts, q.tq) as rank
         from memories m, q
         where m.namespace=$1 and m.status='active' and m.id <> $3 and ${FRESH_M}
           and m.fts @@ q.tq and ts_rank(m.fts, q.tq) >= ${SIMILAR_MIN_RANK}
         order by rank desc limit ${SIMILAR_K}`,
        [this.namespace, memory.content, memory.id]
      );
      return rows.map(({ rank: _rank, ...m }: Record<string, unknown>) => m as Memory);
    } catch {
      return [];
    }
  }

  private async ftsRecall(query: string, k: number, config: "english" | "simple"): Promise<Memory[]> {
    const col = config === "simple" ? "fts_simple" : "fts";
    const { rows } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active' and ${FRESH}
         and ${col} @@ websearch_to_tsquery('${config}', $2)
       order by ts_rank(${col}, websearch_to_tsquery('${config}', $2)) desc
       limit $3`,
      [this.namespace, query, k]
    );
    return rows;
  }

  private async vectorRecall(query: string, k: number): Promise<Memory[]> {
    if (!this.embedder) return [];
    const [vec] = await this.embedder.embed([query]);
    const { rows } = await this.pool.query(
      `select ${COLS_M}
       from memories m
       join memory_embeddings e on e.memory_id = m.id
       where m.namespace=$1 and m.status='active' and ${FRESH_M}
         and e.provider=$2 and e.model=$3 and e.dim=$4
       order by e.embedding <=> $5::vector
       limit $6`,
      [this.namespace, this.embedder.provider, this.embedder.model, this.embedder.dim, toVectorLiteral(vec), k]
    );
    return rows;
  }

  async recall(query: string, k = 8): Promise<Memory[]> {
    const fetchK = Math.max(k * 3, 24);
    const [vec, english, simple] = await Promise.all([
      this.embedder ? this.vectorRecall(query, fetchK).catch(() => [] as Memory[]) : Promise.resolve([] as Memory[]),
      this.ftsRecall(query, fetchK, "english"),
      this.ftsRecall(query, fetchK, "simple"),
    ]);
    const ranked = rrfCandidates([vec, english, simple])
      .map((c) => ({
        memory: c.memory,
        score: c.rrf * recencyBoost(c.memory.last_confirmed_at) * salienceBoost(c.memory.salience),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((c) => c.memory);
    if (ranked.length) {
      await this.pool.query(
        `update memories set access_count = access_count + 1, last_accessed_at = now() where id = any($1::uuid[])`,
        [ranked.map((m) => m.id)]
      );
    }
    return ranked;
  }

  async context(): Promise<ContextResult> {
    const scoreExpr = `(${SALIENCE_FLOOR} + 0.5 * salience) * (${RECENCY_FLOOR} + ${RECENCY_SPAN} * exp(-(extract(epoch from now() - last_confirmed_at) / 86400.0) / ${RECENCY_HALF_DAYS}))`;
    const { rows: peer } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active' and kind='peer-card'
       order by created_at desc limit 1`,
      [this.namespace]
    );
    const { rows: top } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active' and (kind is null or kind <> 'peer-card') and ${FRESH}
       order by ${scoreExpr} desc limit ${CONTEXT_TOP}`,
      [this.namespace]
    );
    const { rows: recent } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active' and (kind is null or kind <> 'peer-card') and ${FRESH}
       order by created_at desc limit ${CONTEXT_RECENT}`,
      [this.namespace]
    );
    const seen = new Set(top.map((m: Memory) => m.id));
    return {
      peerCard: peer[0] ?? null,
      top,
      recent: recent.filter((m: Memory) => !seen.has(m.id)),
    };
  }

  async list(filter: { kind?: string; status?: string; client?: string } = {}): Promise<Memory[]> {
    const { rows } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1
         and ($2::text is null or kind=$2)
         and ($3::text is null or status=$3)
         and ($4::text is null or client=$4)
       order by created_at desc`,
      [this.namespace, filter.kind ?? null, filter.status ?? null, filter.client ?? null]
    );
    return rows;
  }

  async forget(idOrPrefix: string): Promise<boolean> {
    const id = await this.resolveId(idOrPrefix);
    if (!id) return false;
    const { rowCount } = await this.pool.query(
      `update memories set status='archived' where id=$1 and namespace=$2`,
      [id, this.namespace]
    );
    return (rowCount ?? 0) === 1;
  }

  async confirm(idOrPrefix: string): Promise<boolean> {
    const id = await this.resolveId(idOrPrefix);
    if (!id) return false;
    const { rowCount } = await this.pool.query(
      `update memories
       set last_confirmed_at = now(),
           confidence = least(1.0, confidence + 0.1)
       where id=$1 and namespace=$2`,
      [id, this.namespace]
    );
    return (rowCount ?? 0) === 1;
  }

  async shouldAutoDream(hours: number, newThreshold: number): Promise<boolean> {
    const { rows } = await this.pool.query(
      `with last as (select value::timestamptz as t from memhub_meta where key = $1)
       select
         (not exists (select 1 from last)
          or now() - (select t from last) >= make_interval(hours => $2)) as time_ok,
         (select count(*)::int from memories
            where namespace = $3 and status = 'active' and level = 'explicit'
              and created_at > coalesce((select t from last), to_timestamp(0))) as new_count`,
      [`last_dream:${this.namespace}`, hours, this.namespace]
    );
    return rows[0].time_ok === true && rows[0].new_count >= newThreshold;
  }

  async markDreamed(): Promise<void> {
    await this.pool.query(
      `insert into memhub_meta (key, value, updated_at) values ($1, now()::text, now())
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [`last_dream:${this.namespace}`]
    );
  }

  async stale(olderThanDays: number, limit = 20): Promise<Memory[]> {
    const { rows } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active'
         and last_confirmed_at < now() - make_interval(days => $2::int)
       order by last_confirmed_at asc
       limit $3`,
      [this.namespace, olderThanDays, limit]
    );
    return rows;
  }

  async history(idOrPrefix: string): Promise<Memory[]> {
    const id = await this.resolveId(idOrPrefix);
    if (!id) return [];
    const { rows } = await this.pool.query(
      `with recursive chain as (
         select ${COLS}, 0 as depth from memories where id = $1 and namespace = $2
         union all
         select ${COLS_M}, c.depth + 1
         from memories m join chain c on m.superseded_by = c.id
         where m.namespace = $2 and c.depth < 1000
       )
       select * from chain order by depth`,
      [id, this.namespace]
    );
    return rows.map(({ depth: _depth, ...m }: Record<string, unknown>) => m as Memory);
  }

  async supersede(oldIdOrPrefix: string, newContent: string): Promise<Memory> {
    const oldId = await this.resolveId(oldIdOrPrefix);
    if (!oldId) throw new Error(`No memory ${oldIdOrPrefix} to supersede.`);
    const conn = await this.pool.connect();
    let result: { memory: Memory; inserted: boolean };
    try {
      await conn.query("begin");
      const { rows: prev } = await conn.query(
        `select kind, tags, source, level, salience, status
         from memories where id=$1 and namespace=$2 for update`,
        [oldId, this.namespace]
      );
      if (!prev[0]) throw new Error(`No memory ${oldIdOrPrefix} to supersede.`);
      if (prev[0].status === "superseded") throw new Error(`Memory ${oldIdOrPrefix} was already superseded.`);
      const p = prev[0];
      result = await this.upsertMemory(conn, {
        content: newContent,
        kind: p.kind ?? undefined,
        tags: p.tags,
        source: p.source ?? undefined,
        level: p.level ?? "explicit",
        salience: p.salience,
      });
      if (result.memory.id !== oldId) {
        const { rowCount } = await conn.query(
          `update memories set status='superseded', superseded_by=$1
           where id=$2 and namespace=$3`,
          [result.memory.id, oldId, this.namespace]
        );
        if ((rowCount ?? 0) !== 1) throw new Error(`No memory ${oldIdOrPrefix} to supersede.`);
      }
      await conn.query("commit");
    } catch (e) {
      try { await conn.query("rollback"); } catch {}
      throw e;
    } finally {
      conn.release();
    }
    await this.ensureEmbedding(result.memory);
    return result.memory;
  }
}

import type { Pool, PoolClient } from "pg";
import type { Embedder } from "../embeddings/types.js";

export type Memory = {
  id: string; namespace: string; content: string; kind: string | null;
  tags: string[]; source: string | null; confidence: number;
  level: string; status: string; created_at: string; last_confirmed_at: string;
};

const COL_LIST = [
  "id", "namespace", "content", "kind", "tags", "source", "confidence", "level", "status",
  "created_at::text", "last_confirmed_at::text",
];
const COLS = COL_LIST.join(", ");
const COLS_M = COL_LIST.map((c) => "m." + c).join(", ");

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function rrfMerge(lists: Memory[][], k: number): Memory[] {
  const score = new Map<string, number>();
  const byId = new Map<string, Memory>();
  for (const list of lists) {
    list.forEach((m, rank) => {
      byId.set(m.id, m);
      score.set(m.id, (score.get(m.id) ?? 0) + 1 / (60 + rank));
    });
  }
  return [...byId.values()]
    .sort((a, b) => (score.get(b.id)! - score.get(a.id)!))
    .slice(0, k);
}

export class MemoryStore {
  constructor(private pool: Pool, private namespace: string, private embedder?: Embedder) {}

  private async insertMemory(
    exec: Pool | PoolClient,
    input: { content: string; kind?: string; tags?: string[]; source?: string; confidence?: number; level?: string }
  ): Promise<Memory> {
    const { rows } = await exec.query(
      `insert into memories (namespace, content, kind, tags, source, confidence, level)
       values ($1,$2,$3,$4,$5,$6,$7) returning ${COLS}`,
      [this.namespace, input.content, input.kind ?? null, input.tags ?? [],
       input.source ?? null, input.confidence ?? 0.7, input.level ?? 'explicit']
    );
    return rows[0];
  }

  async remember(input: { content: string; kind?: string; tags?: string[]; source?: string; confidence?: number; level?: string }): Promise<Memory> {
    const memory = await this.insertMemory(this.pool, input);
    if (this.embedder) {
      // best-effort: a failed embed must never lose the memory
      try {
        const [vec] = await this.embedder.embed([memory.content]);
        await this.pool.query(
          `insert into memory_embeddings (memory_id, provider, model, dim, embedding)
           values ($1,$2,$3,$4,$5::vector)
           on conflict (memory_id, provider, model) do update set embedding = excluded.embedding`,
          [memory.id, this.embedder.provider, this.embedder.model, this.embedder.dim, toVectorLiteral(vec)]
        );
      } catch {
        // degrade to full-text only
      }
    }
    return memory;
  }

  private async ftsRecall(query: string, k: number): Promise<Memory[]> {
    const { rows } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active'
         and fts @@ websearch_to_tsquery('english', $2)
       order by ts_rank(fts, websearch_to_tsquery('english', $2)) desc
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
       where m.namespace=$1 and m.status='active'
         and e.provider=$2 and e.model=$3 and e.dim=$4
       order by e.embedding <=> $5::vector
       limit $6`,
      [this.namespace, this.embedder.provider, this.embedder.model, this.embedder.dim, toVectorLiteral(vec), k]
    );
    return rows;
  }

  async recall(query: string, k = 8): Promise<Memory[]> {
    if (!this.embedder) return this.ftsRecall(query, k);
    const fts = await this.ftsRecall(query, k);
    let vec: Memory[] = [];
    try {
      vec = await this.vectorRecall(query, k);
    } catch {
      // embedder/vector unavailable — degrade to full-text only
    }
    return rrfMerge([vec, fts], k);
  }

  async list(filter: { kind?: string; status?: string } = {}): Promise<Memory[]> {
    const { rows } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1
         and ($2::text is null or kind=$2)
         and ($3::text is null or status=$3)
       order by created_at desc`,
      [this.namespace, filter.kind ?? null, filter.status ?? null]
    );
    return rows;
  }

  async forget(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update memories set status='archived' where id=$1 and namespace=$2`,
      [id, this.namespace]
    );
    return (rowCount ?? 0) === 1;
  }

  async confirm(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update memories
       set last_confirmed_at = now(),
           confidence = least(1.0, confidence + 0.1)
       where id=$1 and namespace=$2`,
      [id, this.namespace]
    );
    return (rowCount ?? 0) === 1;
  }

  async dedupeExact(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `with ranked as (
         select id, row_number() over (
           partition by content
           order by last_confirmed_at desc, created_at desc
         ) as rn
         from memories
         where namespace=$1 and status='active'
       )
       update memories m set status='archived'
       from ranked r
       where m.id = r.id and r.rn > 1`,
      [this.namespace]
    );
    return rowCount ?? 0;
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

  async history(id: string): Promise<Memory[]> {
    const { rows } = await this.pool.query(
      `with recursive chain as (
         select id, namespace, content, kind, tags, source, confidence, level, status,
                created_at::text as created_at, last_confirmed_at::text as last_confirmed_at, 0 as depth
         from memories where id = $1 and namespace = $2
         union all
         select m.id, m.namespace, m.content, m.kind, m.tags, m.source, m.confidence, m.level, m.status,
                m.created_at::text, m.last_confirmed_at::text, c.depth + 1
         from memories m join chain c on m.superseded_by = c.id
         where m.namespace = $2 and c.depth < 1000
       )
       select id, namespace, content, kind, tags, source, confidence, level, status, created_at, last_confirmed_at
       from chain order by depth`,
      [id, this.namespace]
    );
    return rows;
  }

  async supersede(oldId: string, newContent: string): Promise<Memory> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows: prev } = await client.query(
        "select level from memories where id=$1 and namespace=$2",
        [oldId, this.namespace]
      );
      const fresh = await this.insertMemory(client, { content: newContent, level: prev[0]?.level ?? "explicit" });
      const { rowCount } = await client.query(
        `update memories set status='superseded', superseded_by=$1
         where id=$2 and namespace=$3`,
        [fresh.id, oldId, this.namespace]
      );
      if ((rowCount ?? 0) !== 1) {
        await client.query("rollback");
        throw new Error(`No memory ${oldId} to supersede.`);
      }
      await client.query("commit");
      return fresh;
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }
}

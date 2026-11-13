import type { Pool, PoolClient } from "pg";
import type { Embedder } from "../embeddings/types.js";
import { projectScope } from "../project.js";

export type PreviousVersion = { content: string; superseded_at: string | null; reason: string | null };

export type Memory = {
  id: string; namespace: string; content: string; kind: string | null;
  tags: string[]; source: string | null; confidence: number;
  level: string; status: string; salience: number; client: string | null;
  observed_at: string | null; expires_at: string | null; access_count: number;
  created_at: string; last_confirmed_at: string; last_accessed_at: string | null;
  scope: string; strength: number;
  previous?: PreviousVersion;
};

export type RememberInput = {
  content: string; kind?: string; tags?: string[]; source?: string;
  confidence?: number; level?: string; salience?: number;
  observedAt?: string; expiresAt?: string;
  scope?: string; links?: string[];
};

export type RememberResult = { memory: Memory; deduped: boolean; similar: Memory[] };

export type ContextResult = { peerCard: Memory | null; top: Memory[]; recent: Memory[] };

export type RecallOptions = { project?: string | null; deep?: boolean; gate?: boolean; quiet?: boolean };

export type ListFilter = {
  kind?: string; status?: string; client?: string; scope?: string;
  since?: string; limit?: number; offset?: number;
};

export type ListResult = { memories: Memory[]; total: number };

export type Stats = {
  byStatus: Record<string, number>; byKind: Record<string, number>;
  byScope: Record<string, number>; links: number;
};

const COL_LIST = [
  "id", "namespace", "content", "kind", "tags", "source", "confidence", "level", "status",
  "salience", "client", "observed_at::text as observed_at", "expires_at::text as expires_at",
  "access_count", "created_at::text as created_at", "last_confirmed_at::text as last_confirmed_at",
  "last_accessed_at::text as last_accessed_at", "scope", "strength",
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
const STABILITY_DAYS = 60;
const STRENGTH_MAX = 10;
const REINFORCE_SPACING = "1 hour";
const SALIENCE_FLOOR = 0.75;
const CONTEXT_TOP = 12;
const CONTEXT_RECENT = 5;
const LIST_LIMIT = 100;
const LINK_SEEDS = 5;
const LINK_LIST_WEIGHT = 0.5;
const SAME_PROJECT_BOOST = 1.15;
const OTHER_PROJECT_PENALTY = 0.6;
const GATE_MIN_SCORE = 4.6;
const GATE_CORPUS_FLOOR = 50;
const GATE_MAX_DISTANCE = 0.5;
const GATE_MIN_Z = 2.5;
const GATE_MIN_CORPUS = 30;
const INJECT_MIN_CONFIDENCE = 0.5;
const FADE_RETENTION = 0.05;
const FADE_MAX_SALIENCE = 0.7;
const FADE_MIN_AGE_DAYS = 30;
const PREVIOUS_MAX_CHARS = 160;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX_RE = /^[0-9a-f][0-9a-f-]{5,35}$/;

const LAST_TOUCH = "greatest(last_confirmed_at, coalesce(last_accessed_at, last_confirmed_at))";
const RETENTION_SQL = `exp(-(extract(epoch from now() - ${LAST_TOUCH}) / 86400.0) / (${STABILITY_DAYS} * strength))`;

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function rrfCandidates(lists: Memory[][], weights: number[] = []): { memory: Memory; rrf: number }[] {
  const score = new Map<string, number>();
  const byId = new Map<string, Memory>();
  lists.forEach((list, i) => {
    const w = weights[i] ?? 1;
    list.forEach((m, rank) => {
      if (!byId.has(m.id)) byId.set(m.id, m);
      score.set(m.id, (score.get(m.id) ?? 0) + w / (60 + rank));
    });
  });
  return [...byId.values()].map((m) => ({ memory: m, rrf: score.get(m.id)! }));
}

export function retention(m: Pick<Memory, "last_confirmed_at" | "last_accessed_at" | "strength">, now = Date.now()): number {
  const confirmed = Date.parse(m.last_confirmed_at);
  const accessed = m.last_accessed_at ? Date.parse(m.last_accessed_at) : NaN;
  const touch = Math.max(Number.isFinite(confirmed) ? confirmed : -Infinity, Number.isFinite(accessed) ? accessed : -Infinity);
  if (!Number.isFinite(touch)) return 1;
  const days = Math.max(0, (now - touch) / 86400000);
  return Math.exp(-days / (STABILITY_DAYS * Math.max(1, m.strength)));
}

function recencyBoost(m: Memory): number {
  return RECENCY_FLOOR + RECENCY_SPAN * retention(m);
}

function salienceBoost(salience: number): number {
  return SALIENCE_FLOOR + 0.5 * salience;
}

function scopeBoost(scope: string, project: string | null | undefined): number {
  if (!project || scope === "global") return 1;
  return scope === projectScope(project) ? SAME_PROJECT_BOOST : OTHER_PROJECT_PENALTY;
}

function injectable(m: Memory): boolean {
  return m.confidence >= INJECT_MIN_CONFIDENCE && m.kind !== "peer-card" && m.kind !== "episode";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
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
    const revived = await exec.query(
      `update memories m set status='active', last_confirmed_at = now(),
         strength = least(${STRENGTH_MAX}, m.strength + 1)
       where m.namespace=$1 and m.status='faded'
         and m.content_hash = md5(lower(regexp_replace(btrim($2), '\\s+', ' ', 'g')))
         and not exists (select 1 from memories a where a.namespace=$1 and a.status='active' and a.content_hash = m.content_hash)
       returning ${COLS_M}`,
      [this.namespace, input.content]
    );
    if (revived.rows[0]) return { memory: revived.rows[0], inserted: false };
    const { rows } = await exec.query(
      `insert into memories (namespace, content, kind, tags, source, confidence, level, salience, client, observed_at, expires_at, scope)
       values ($1,$2,$3,$4,$5,coalesce($6::real, 0.7),$7,coalesce($8::real, 0.5),$9,$10,$11,coalesce($12, 'global'))
       on conflict (namespace, content_hash) where status = 'active' do update set
         last_confirmed_at = now(),
         confidence = least(1.0, coalesce($6::real, memories.confidence + 0.1)),
         salience = coalesce($8::real, memories.salience),
         strength = least(${STRENGTH_MAX}, memories.strength + 1),
         kind = coalesce(excluded.kind, memories.kind),
         tags = case when excluded.tags <> '{}' then excluded.tags else memories.tags end,
         source = coalesce(excluded.source, memories.source),
         observed_at = coalesce(excluded.observed_at, memories.observed_at),
         expires_at = excluded.expires_at,
         scope = coalesce($12, memories.scope)
       returning ${COLS}, (xmax::text = '0') as inserted`,
      [this.namespace, input.content, input.kind ?? null, input.tags ?? [],
       input.source ?? null, input.confidence ?? null, input.level ?? "explicit",
       input.salience ?? null, this.client?.() ?? null, input.observedAt ?? null, input.expiresAt ?? null,
       input.scope ?? null]
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
    for (const target of input.links ?? []) {
      try { await this.link(memory.id, target); } catch {}
    }
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

  private async ftsRecall(query: string, k: number, config: "english" | "simple", statuses: string[]): Promise<Memory[]> {
    const col = config === "simple" ? "fts_simple" : "fts";
    const { rows } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status = any($4) and ${FRESH}
         and ${col} @@ websearch_to_tsquery('${config}', $2)
       order by ts_rank(${col}, websearch_to_tsquery('${config}', $2)) desc
       limit $3`,
      [this.namespace, query, k, statuses]
    );
    return rows;
  }

  private async gatedLexicalRecall(query: string, k: number): Promise<Memory[]> {
    const { rows } = await this.pool.query(
      `with ql as (select distinct lex from unnest(tsvector_to_array(to_tsvector('english', $2))) as lex),
       corpus as (
         select id, tsvector_to_array(fts) as lx from memories
         where namespace=$1 and status='active' and ${FRESH} and confidence >= ${INJECT_MIN_CONFIDENCE}
           and (kind is null or kind not in ('peer-card', 'episode'))
       ),
       n as (select greatest(count(*), ${GATE_CORPUS_FLOOR})::float8 as n from corpus),
       df as (
         select ql.lex, count(*)::float8 as df
         from ql join corpus c on ql.lex = any(c.lx) group by ql.lex
       ),
       idf as (select df.lex, ln(1 + (n.n - df.df + 0.5) / (df.df + 0.5)) as w from df, n),
       scored as (
         select c.id, sum(idf.w) as score
         from corpus c join idf on idf.lex = any(c.lx) group by c.id
       )
       select ${COLS_M}
       from scored s join memories m on m.id = s.id
       where s.score >= ${GATE_MIN_SCORE}
       order by s.score desc limit $3`,
      [this.namespace, query, k]
    );
    return rows;
  }

  private async vectorRecall(query: string, k: number, statuses: string[], gate: boolean): Promise<Memory[]> {
    if (!this.embedder) return [];
    const [vec] = await this.embedder.embed([query]);
    const { rows } = await this.pool.query(
      `with d as (
         select m.id, (e.embedding <=> $5::vector) as dist
         from memories m join memory_embeddings e on e.memory_id = m.id
         where m.namespace=$1 and m.status = any($7) and ${FRESH_M}
           and e.provider=$2 and e.model=$3 and e.dim=$4
       ),
       st as (select count(*) as n, avg(dist) as mean, coalesce(stddev_pop(dist), 0) as sd from d)
       select ${COLS_M}
       from d join memories m on m.id = d.id, st
       where not $8::boolean
          or m.confidence >= ${INJECT_MIN_CONFIDENCE} and (m.kind is null or m.kind <> 'peer-card') and (d.dist <= ${GATE_MAX_DISTANCE}
          or (st.n >= ${GATE_MIN_CORPUS} and st.sd > 0 and (st.mean - d.dist) / st.sd >= ${GATE_MIN_Z}))
       order by d.dist
       limit $6`,
      [this.namespace, this.embedder.provider, this.embedder.model, this.embedder.dim, toVectorLiteral(vec), k, statuses, gate]
    );
    return rows;
  }

  private async linkedNeighbours(seeds: { id: string; score: number }[], k: number): Promise<Memory[]> {
    if (!seeds.length) return [];
    const { rows } = await this.pool.query(
      `with seeds as (select * from unnest($1::uuid[], $2::float8[]) as s(id, score)),
       edges as (
         select l.src as a, l.dst as b, l.weight from memory_links l where l.src = any($1::uuid[])
         union all
         select l.dst as a, l.src as b, l.weight from memory_links l where l.dst = any($1::uuid[])
       ),
       deg as (select a, count(*)::float8 as d from edges group by a)
       select ${COLS_M}, sum(s.score * e.weight / deg.d) as lscore
       from edges e
       join seeds s on s.id = e.a
       join deg on deg.a = e.a
       join memories m on m.id = e.b
       where m.namespace=$3 and m.status='active' and ${FRESH_M} and not (m.id = any($1::uuid[]))
       group by m.id
       order by lscore desc limit $4`,
      [seeds.map((s) => s.id), seeds.map((s) => s.score), this.namespace, k]
    );
    return rows.map(({ lscore: _l, ...m }: Record<string, unknown>) => m as Memory);
  }

  private async candidateLists(query: string, fetchK: number, statuses: string[], gate: boolean): Promise<Memory[][]> {
    const vec = this.embedder
      ? this.vectorRecall(query, fetchK, statuses, gate).catch(() => [] as Memory[])
      : Promise.resolve([] as Memory[]);
    if (gate) return Promise.all([vec, this.gatedLexicalRecall(query, fetchK)]);
    return Promise.all([
      vec,
      this.ftsRecall(query, fetchK, "english", statuses),
      this.ftsRecall(query, fetchK, "simple", statuses),
    ]);
  }

  private async attachPrevious(memories: Memory[]): Promise<void> {
    if (!memories.length) return;
    const { rows } = await this.pool.query(
      `select distinct on (superseded_by) superseded_by as id, content,
              superseded_at::text as superseded_at, supersede_reason as reason
       from memories
       where namespace=$1 and status='superseded' and superseded_by = any($2::uuid[])
       order by superseded_by, superseded_at desc nulls last, created_at desc`,
      [this.namespace, memories.map((m) => m.id)]
    );
    const byId = new Map<string, PreviousVersion>();
    for (const r of rows) {
      byId.set(r.id, { content: clip(r.content, PREVIOUS_MAX_CHARS), superseded_at: r.superseded_at, reason: r.reason });
    }
    for (const m of memories) {
      const prev = byId.get(m.id);
      if (prev) m.previous = prev;
    }
  }

  async recall(query: string, k = 8, opts: RecallOptions = {}): Promise<Memory[]> {
    const fetchK = Math.max(k * 3, 24);
    const gate = opts.gate === true;
    let lists = await this.candidateLists(query, fetchK, opts.deep ? ["active", "faded"] : ["active"], gate);
    if (!gate && !opts.deep && lists.every((l) => l.length === 0)) {
      lists = await this.candidateLists(query, fetchK, ["active", "faded"], false);
    }
    const seeds = rrfCandidates(lists)
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, LINK_SEEDS)
      .map((c) => ({ id: c.memory.id, score: c.rrf }));
    const linked = await this.linkedNeighbours(seeds, fetchK).catch(() => [] as Memory[]);
    const ranked = rrfCandidates([...lists, linked], [...lists.map(() => 1), LINK_LIST_WEIGHT])
      .filter((c) => !gate || injectable(c.memory))
      .map((c) => ({
        memory: c.memory,
        score: c.rrf * recencyBoost(c.memory) * salienceBoost(c.memory.salience) * scopeBoost(c.memory.scope, opts.project),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((c) => c.memory);
    if (ranked.length && opts.quiet) await this.attachPrevious(ranked);
    if (ranked.length && !opts.quiet) {
      await this.pool.query(
        `update memories set
           access_count = access_count + 1,
           strength = case
             when last_accessed_at is null or last_accessed_at < now() - interval '${REINFORCE_SPACING}'
             then least(${STRENGTH_MAX}, strength + 1) else strength end,
           status = case when status = 'faded' then 'active' else status end,
           last_accessed_at = now()
         where id = any($1::uuid[])`,
        [ranked.map((m) => m.id)]
      );
      for (const m of ranked) if (m.status === "faded") m.status = "active";
      await this.attachPrevious(ranked);
    }
    return ranked;
  }

  async context(project?: string | null): Promise<ContextResult> {
    const scoreExpr = `(${SALIENCE_FLOOR} + 0.5 * salience) * (${RECENCY_FLOOR} + ${RECENCY_SPAN} * ${RETENTION_SQL})`;
    const scopes = ["global", ...(project ? [projectScope(project)!] : [])];
    const inScope = `confidence >= ${INJECT_MIN_CONFIDENCE} and ` + (project === undefined ? "true" : "scope = any($2)");
    const params = project === undefined ? [this.namespace] : [this.namespace, scopes];
    const { rows: peer } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active' and kind='peer-card'
       order by created_at desc limit 1`,
      [this.namespace]
    );
    const { rows: top } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active' and (kind is null or kind <> 'peer-card') and ${FRESH} and ${inScope}
       order by ${scoreExpr} desc limit ${CONTEXT_TOP}`,
      params
    );
    const { rows: recent } = await this.pool.query(
      `select ${COLS} from memories
       where namespace=$1 and status='active' and (kind is null or kind <> 'peer-card') and ${FRESH} and ${inScope}
       order by created_at desc limit ${CONTEXT_RECENT}`,
      params
    );
    const seen = new Set(top.map((m: Memory) => m.id));
    const extras = recent.filter((m: Memory) => !seen.has(m.id));
    await this.attachPrevious([...top, ...extras]);
    return { peerCard: peer[0] ?? null, top, recent: extras };
  }

  async list(filter: ListFilter = {}): Promise<Memory[]> {
    return (await this.listPage(filter)).memories;
  }

  async listPage(filter: ListFilter = {}): Promise<ListResult> {
    const where = `namespace=$1
         and ($2::text is null or kind=$2)
         and ($3::text is null or status=$3)
         and ($4::text is null or client=$4)
         and ($5::text is null or scope=$5)
         and ($6::timestamptz is null or created_at > $6)`;
    const base = [this.namespace, filter.kind ?? null, filter.status ?? null, filter.client ?? null,
      filter.scope ?? null, filter.since ?? null];
    const { rows } = await this.pool.query(
      `select ${COLS} from memories where ${where}
       order by created_at desc, id limit $7 offset $8`,
      [...base, filter.limit ?? LIST_LIMIT, filter.offset ?? 0]
    );
    const { rows: count } = await this.pool.query(`select count(*)::int as n from memories where ${where}`, base);
    return { memories: rows, total: count[0].n };
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
           confidence = least(1.0, confidence + 0.1),
           strength = least(${STRENGTH_MAX}, strength + 1),
           status = case when status = 'faded' then 'active' else status end
       where id=$1 and namespace=$2`,
      [id, this.namespace]
    );
    return (rowCount ?? 0) === 1;
  }

  async link(aIdOrPrefix: string, bIdOrPrefix: string, relation = "related", weight = 1): Promise<boolean> {
    const [a, b] = await Promise.all([this.resolveId(aIdOrPrefix), this.resolveId(bIdOrPrefix)]);
    if (!a || !b || a === b) return false;
    const { rowCount } = await this.pool.query(
      `insert into memory_links (src, dst, relation, weight)
       select $1, $2, $3, $4
       where (select count(*) from memories where namespace=$5 and id in ($1, $2)) = 2
       on conflict (src, dst, relation) do update set weight = excluded.weight`,
      [a, b, relation.trim() || "related", weight, this.namespace]
    );
    return (rowCount ?? 0) === 1;
  }

  async linksOf(idOrPrefix: string): Promise<{ relation: string; direction: "out" | "in"; memory: Memory }[]> {
    const id = await this.resolveId(idOrPrefix);
    if (!id) return [];
    const { rows } = await this.pool.query(
      `select l.relation, case when l.src = $1 then 'out' else 'in' end as direction, ${COLS_M}
       from memory_links l
       join memories m on m.id = case when l.src = $1 then l.dst else l.src end
       where (l.src = $1 or l.dst = $1) and m.namespace = $2
       order by l.created_at`,
      [id, this.namespace]
    );
    return rows.map(({ relation, direction, ...m }: Record<string, unknown>) => ({
      relation: relation as string, direction: direction as "out" | "in", memory: m as Memory,
    }));
  }

  async fade(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `update memories set status='faded'
       where namespace=$1 and status='active'
         and (kind is null or kind <> 'peer-card')
         and salience < ${FADE_MAX_SALIENCE}
         and created_at < now() - make_interval(days => ${FADE_MIN_AGE_DAYS})
         and ${RETENTION_SQL} < ${FADE_RETENTION}`,
      [this.namespace]
    );
    return rowCount ?? 0;
  }

  async stats(): Promise<Stats> {
    const group = async (col: string): Promise<Record<string, number>> => {
      const filter = col === "status" ? "" : "and status='active'";
      const { rows } = await this.pool.query(
        `select coalesce(${col}, 'note') as k, count(*)::int as n from memories
         where namespace=$1 ${filter} group by 1 order by 2 desc`,
        [this.namespace]
      );
      return Object.fromEntries(rows.map((r) => [r.k, r.n]));
    };
    const [byStatus, byKind, byScope] = await Promise.all([group("status"), group("kind"), group("scope")]);
    const { rows: l } = await this.pool.query(
      `select count(*)::int as n from memory_links l join memories m on m.id = l.src where m.namespace=$1`,
      [this.namespace]
    );
    return { byStatus, byKind, byScope, links: l[0].n };
  }

  async lastDreamAt(): Promise<string | null> {
    const { rows } = await this.pool.query(`select value from memhub_meta where key = $1`, [`last_dream:${this.namespace}`]);
    return rows[0]?.value ?? null;
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

  async supersede(oldIdOrPrefix: string, newContent: string, reason?: string): Promise<Memory> {
    const oldId = await this.resolveId(oldIdOrPrefix);
    if (!oldId) throw new Error(`No memory ${oldIdOrPrefix} to supersede.`);
    const conn = await this.pool.connect();
    let result: { memory: Memory; inserted: boolean };
    try {
      await conn.query("begin");
      const { rows: prev } = await conn.query(
        `select kind, tags, source, level, salience, status, scope
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
        scope: p.scope,
      });
      if (result.memory.id !== oldId) {
        const { rowCount } = await conn.query(
          `update memories set status='superseded', superseded_by=$1, superseded_at=now(), supersede_reason=$4
           where id=$2 and namespace=$3`,
          [result.memory.id, oldId, this.namespace, reason?.trim() || null]
        );
        if ((rowCount ?? 0) !== 1) throw new Error(`No memory ${oldIdOrPrefix} to supersede.`);
        await conn.query(
          `insert into memory_links (src, dst, relation, weight)
           select $1, case when l.src = $2 then l.dst else l.src end, l.relation, l.weight
           from memory_links l
           where (l.src = $2 or l.dst = $2) and $1 not in (l.src, l.dst)
           on conflict do nothing`,
          [result.memory.id, oldId]
        );
      }
      await conn.query("commit");
    } catch (e) {
      try { await conn.query("rollback"); } catch {}
      throw e;
    } finally {
      conn.release();
    }
    await this.ensureEmbedding(result.memory);
    await this.attachPrevious([result.memory]);
    return result.memory;
  }
}

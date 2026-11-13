import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";
import { MemoryStore, retention } from "../src/db/store.js";
import { buildToolHandlers } from "../src/mcp/server.js";
import { fmtRecall } from "../src/format.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
});
afterAll(async () => { await pool.end(); await container.stop(); });
beforeEach(async () => { await pool.query("delete from memories"); });

const age = (id: string, days: number) =>
  pool.query(
    `update memories set created_at = now() - make_interval(days => $2::int),
       last_confirmed_at = now() - make_interval(days => $2::int) where id = $1`,
    [id, days]
  );

describe("changing preferences keep their history", () => {
  it("recall returns the current value and shows what it replaced, when, and why", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: yellow } = await s.remember({
      content: "For Remotion videos, the user prefers a yellow background", kind: "preference",
    });
    await s.supersede(yellow.id, "For Remotion videos, the user prefers a red background", "user said red looks better");
    const hits = await s.recall("remotion video background");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toMatch(/red background/);
    expect(hits[0].previous?.content).toMatch(/yellow background/);
    expect(hits[0].previous?.reason).toBe("user said red looks better");
    expect(hits[0].previous?.superseded_at).toBeTruthy();
    expect(fmtRecall(hits[0])).toMatch(/\[was: "For Remotion videos, the user prefers a yellow background" until \d{4}-\d{2}-\d{2} — user said red looks better\]/);
  });

  it("shows only the most recent predecessor after several changes", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: a } = await s.remember({ content: "Video background colour is yellow" });
    const b = await s.supersede(a.id, "Video background colour is red");
    const c = await s.supersede(b.id, "Video background colour is navy");
    const [hit] = await s.recall("video background colour");
    expect(hit.id).toBe(c.id);
    expect(hit.previous?.content).toMatch(/red/);
    expect((await s.history(c.id)).map((m) => m.content)).toEqual([
      "Video background colour is navy", "Video background colour is red", "Video background colour is yellow",
    ]);
  });
});

describe("project scope", () => {
  it("ranks the current project's memory above another project's", async () => {
    const s = new MemoryStore(pool, "u");
    await s.remember({ content: "Package installs use pnpm in the storefront", scope: "project:beta" });
    await s.remember({ content: "Package installs use pnpm in the dashboard", scope: "project:alpha" });
    const hits = await s.recall("pnpm package installs", 8, { project: "alpha" });
    expect(hits.map((h) => h.scope)).toEqual(["project:alpha", "project:beta"]);
  });

  it("context loads global and current-project memories only", async () => {
    const s = new MemoryStore(pool, "u");
    await s.remember({ content: "Prefers short answers" });
    await s.remember({ content: "Alpha deploys to Vercel", scope: "project:alpha" });
    await s.remember({ content: "Beta deploys to Fly", scope: "project:beta" });
    const c = await s.context("alpha");
    const contents = [...c.top, ...c.recent].map((m) => m.content).sort();
    expect(contents).toEqual(["Alpha deploys to Vercel", "Prefers short answers"]);
    const outside = await s.context(null);
    expect([...outside.top, ...outside.recent].map((m) => m.content)).toEqual(["Prefers short answers"]);
  });

  it("the remember tool maps scope 'project' to the session's project", async () => {
    const s = new MemoryStore(pool, "u");
    const h = buildToolHandlers(s, "alpha");
    await h.remember({ content: "Alpha uses Tailwind", scope: "project" });
    await h.remember({ content: "Likes dark themes" });
    const all = await s.list();
    expect(all.find((m) => m.content.includes("Tailwind"))?.scope).toBe("project:alpha");
    expect(all.find((m) => m.content.includes("dark"))?.scope).toBe("global");
  });
});

describe("linked memories", () => {
  it("recall follows a link one step to a memory the query does not mention", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: a } = await s.remember({ content: "Remotion videos use a red background" });
    const { memory: b } = await s.remember({ content: "Brand typeface is Inter Tight" });
    expect((await s.recall("remotion")).map((m) => m.id)).toEqual([a.id]);
    expect(await s.link(a.id, b.id, "related")).toBe(true);
    expect((await s.recall("remotion")).map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("remember can link on write, and supersede carries links to the successor", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: a } = await s.remember({ content: "Remotion videos use a red background" });
    const { memory: b } = await s.remember({ content: "Brand typeface is Inter Tight", links: [a.id.slice(0, 8)] });
    expect((await s.linksOf(a.id)).map((l) => l.memory.id)).toEqual([b.id]);
    const a2 = await s.supersede(a.id, "Remotion videos use a navy background");
    expect((await s.linksOf(a2.id)).map((l) => l.memory.id)).toEqual([b.id]);
  });

  it("refuses self-links and links to unknown ids", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: a } = await s.remember({ content: "solo fact" });
    expect(await s.link(a.id, a.id)).toBe(false);
    expect(await s.link(a.id, "00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("gated recall for automatic injection", () => {
  const seed = async (s: MemoryStore) => {
    const fillers = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    for (const f of fillers) await s.remember({ content: `The ${f} project has its own repository` });
    await s.remember({ content: "For Remotion videos the user prefers a red background" });
    await s.remember({ content: "The storefront project deploys to Vercel" });
  };

  it("injects a memory that shares rare terms with the prompt", async () => {
    const s = new MemoryStore(pool, "u");
    await seed(s);
    const hits = await s.recall("create a new remotion video for the launch", 3, { gate: true });
    expect(hits.map((h) => h.content)).toEqual(["For Remotion videos the user prefers a red background"]);
  });

  it("injects nothing when the prompt shares only a common word", async () => {
    const s = new MemoryStore(pool, "u");
    await seed(s);
    expect(await s.recall("tidy up the project a little", 3, { gate: true })).toEqual([]);
  });

  it("still injects when the topic is common across the user's memories", async () => {
    const s = new MemoryStore(pool, "u");
    await s.remember({ content: "For Remotion videos, use a red background with white text" });
    await s.remember({ content: "Remotion videos render at 1080p" });
    await s.remember({ content: "Remotion videos use the Inter Tight typeface" });
    await s.remember({ content: "In the remotion-demo repo, use pnpm" });
    await s.remember({ content: "Commit messages use the imperative mood" });
    const hits = await s.recall("make a remotion video for the onboarding flow", 3, { gate: true });
    expect(hits).toHaveLength(3);
    for (const h of hits) expect(h.content).toMatch(/Remotion videos/);
  });

  it("needs two shared terms in a small memory, where one could be coincidence", async () => {
    const s = new MemoryStore(pool, "u");
    await s.remember({ content: "Invoices go out on the first of the month" });
    await s.remember({ content: "Remotion videos render at 1080p" });
    expect(await s.recall("where is the invoice template stored", 3, { gate: true })).toEqual([]);
    const hits = await s.recall("send the invoices for this month", 3, { gate: true });
    expect(hits.map((h) => h.content)).toEqual(["Invoices go out on the first of the month"]);
  });

  it("never injects episodes or the profile card, even through a link", async () => {
    const s = new MemoryStore(pool, "u");
    await seed(s);
    const { memory: pref } = (await s.listPage({})).memories
      .filter((m) => m.content.includes("Remotion"))
      .map((memory) => ({ memory }))[0];
    const { memory: episode } = await s.remember({
      content: "2026-11-12: built a Remotion launch video and settled the background", kind: "episode",
    });
    await s.remember({ content: "IDENTITY: makes Remotion launch videos", kind: "peer-card" });
    await s.link(pref.id, episode.id, "from_episode");
    const hits = await s.recall("create a new remotion video for the launch", 3, { gate: true });
    expect(hits.map((h) => h.id)).toEqual([pref.id]);
    expect((await s.recall("remotion launch video")).map((h) => h.id)).toContain(episode.id);
  });

  it("keeps a tentative memory out of injection until it is confirmed", async () => {
    const s = new MemoryStore(pool, "u");
    await seed(s);
    const { memory: guess } = await s.remember({
      content: "For Remotion videos the user may want burned-in captions", confidence: 0.4, level: "inductive",
    });
    const before = await s.recall("remotion captions", 3, { gate: true });
    expect(before.map((h) => h.id)).not.toContain(guess.id);
    expect((await s.recall("captions")).map((h) => h.id)).toContain(guess.id);
    await s.confirm(guess.id);
    const after = await s.recall("remotion captions", 3, { gate: true });
    expect(after.map((h) => h.id)).toContain(guess.id);
  });
});

describe("strength, fading, and revival", () => {
  it("recall reinforces strength once per spacing window", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: m } = await s.remember({ content: "kestrel fact" });
    await s.recall("kestrel");
    await s.recall("kestrel");
    const { rows } = await pool.query("select strength, access_count from memories where id=$1", [m.id]);
    expect(rows[0].strength).toBe(2);
    expect(rows[0].access_count).toBe(2);
  });

  it("a quiet recall does not reinforce", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: m } = await s.remember({ content: "kestrel fact" });
    await s.recall("kestrel", 8, { quiet: true });
    const { rows } = await pool.query("select strength, access_count from memories where id=$1", [m.id]);
    expect(rows[0].strength).toBe(1);
    expect(rows[0].access_count).toBe(0);
  });

  it("a stronger memory retains more after the same idle time", () => {
    const old = new Date(Date.now() - 120 * 86400000).toISOString();
    const weak = retention({ last_confirmed_at: old, last_accessed_at: null, strength: 1 });
    const strong = retention({ last_confirmed_at: old, last_accessed_at: null, strength: 5 });
    expect(weak).toBeLessThan(0.2);
    expect(strong).toBeGreaterThan(0.6);
  });

  it("fade retires long-unused low-salience memories and spares salient or recent ones", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: dull } = await s.remember({ content: "old trivia about badgers", salience: 0.3 });
    const { memory: rule } = await s.remember({ content: "old rule about otters", salience: 0.9 });
    const { memory: fresh } = await s.remember({ content: "new trivia about herons", salience: 0.3 });
    await age(dull.id, 400);
    await age(rule.id, 400);
    expect(await s.fade()).toBe(1);
    expect((await s.list({ status: "faded" })).map((m) => m.id)).toEqual([dull.id]);
    expect((await s.list({ status: "active" })).map((m) => m.id).sort()).toEqual([rule.id, fresh.id].sort());
  });

  it("a faded memory comes back when nothing active matches, and is revived", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: dull } = await s.remember({ content: "old trivia about badgers", salience: 0.3 });
    await age(dull.id, 400);
    await s.fade();
    const hits = await s.recall("badgers");
    expect(hits.map((h) => h.id)).toEqual([dull.id]);
    const { rows } = await pool.query("select status from memories where id=$1", [dull.id]);
    expect(rows[0].status).toBe("active");
  });

  it("a faded memory stays hidden while active ones match, unless recall is deep", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: dull } = await s.remember({ content: "old trivia about badgers", salience: 0.3 });
    await age(dull.id, 400);
    await s.fade();
    const { memory: live } = await s.remember({ content: "badgers dig setts" });
    expect((await s.recall("badgers", 8, { quiet: true })).map((h) => h.id)).toEqual([live.id]);
    expect((await s.recall("badgers", 8, { deep: true })).map((h) => h.id).sort()).toEqual([dull.id, live.id].sort());
  });

  it("re-remembering a faded fact revives it instead of duplicating", async () => {
    const s = new MemoryStore(pool, "u");
    const { memory: dull } = await s.remember({ content: "old trivia about badgers", salience: 0.3 });
    await age(dull.id, 400);
    await s.fade();
    const again = await s.remember({ content: "Old trivia about  badgers" });
    expect(again.deduped).toBe(true);
    expect(again.memory.id).toBe(dull.id);
    expect(again.memory.status).toBe("active");
    expect(await s.list()).toHaveLength(1);
  });
});

describe("paged listing", () => {
  it("returns a page with the total and supports since", async () => {
    const s = new MemoryStore(pool, "u");
    for (let i = 0; i < 5; i++) await s.remember({ content: `fact number ${i}` });
    const page = await s.listPage({ limit: 2 });
    expect(page.memories).toHaveLength(2);
    expect(page.total).toBe(5);
    const h = buildToolHandlers(s);
    expect(await h.list({ limit: 2 })).toMatch(/Showing 1–2 of 5\. Call list again with offset 2/);
    expect(await h.list({ limit: 2, offset: 4 })).not.toMatch(/Showing/);
    const future = new Date(Date.now() + 60000).toISOString();
    expect((await s.listPage({ since: future })).total).toBe(0);
  });
});

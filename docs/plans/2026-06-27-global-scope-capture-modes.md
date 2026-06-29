# Global Scope + Capture Modes (Plan M3b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move config + MCP registration from project-level to **global/user scope**, and add a wizard-selectable **capture mode** (`auto` = Claude saves silently; `manual` = only on request) — both modes keep the manual tools.

**Architecture:** Config moves from `<cwd>/claude-memory.config.json` to `~/.claude-memory/config.json`. MCP registration moves from a project `.mcp.json` to **user scope** via `claude mcp add --scope user`. A new `captureMode` config field drives an idempotent managed block written into `~/.claude/CLAUDE.md` (global instructions) that primes Claude to auto-save when `auto`. The init wizard is rewired around injected dependencies for all of this.

**Tech Stack:** Same as core store — Node ≥20, TypeScript (ESM, strict), `pg`, `zod`, `@clack/prompts`, `vitest` + `@testcontainers/postgresql`, `tsup`. New: `node:child_process` (`execFileSync`) to shell out to the `claude` CLI.

## Global Constraints

- Node ≥ 20, ESM, TypeScript strict.
- No LLM/OpenAI dependency.
- Config + MCP registration + capture setting are **global/user scope**, never project-scoped.
- Config lives at `~/.claude-memory/config.json`; the Postgres URL is a secret — never logged.
- MCP registration uses `claude mcp add --scope user` (do NOT hand-edit `~/.claude.json`).
- The `~/.claude/CLAUDE.md` auto-capture block must be idempotent (re-runnable, removable) and must preserve the user's existing content.
- All paths the wizard writes to are injected as dependencies so tests never touch the real home dir.
- DB-touching tests run against a real Postgres via testcontainers (no SQL mocks).
- Package/bin name: `claude-memory`. MIT.

---

## File Structure

- Modify: `src/config.ts` — global path + `captureMode` field.
- Modify: `tests/config.test.ts` — baseDir + captureMode.
- Create: `src/wizard/register-mcp.ts` — `registerUserMcp` via `claude mcp add --scope user`.
- Create: `tests/register-mcp.test.ts`.
- Create: `src/wizard/capture-snippet.ts` — idempotent managed block in CLAUDE.md.
- Create: `tests/capture-snippet.test.ts`.
- Modify: `src/wizard/init.ts` — rewire to global deps + capture mode.
- Modify: `tests/init.test.ts` — assert global config, MCP call, snippet, migration.
- Delete: `src/wizard/mcp-config.ts` + `tests/mcp-config.test.ts` — superseded by user-scope registration (kept in git history if project-scope is wanted later).
- Modify: `README.md` — global usage + capture mode.

---

### Task 1: Config → global path + captureMode

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Config = { postgresUrl: string; namespace: string; captureMode: "auto" | "manual"; embeddings: { provider: "none" } };
  function configPath(baseDir?: string): string;   // default ~/.claude-memory ; returns <baseDir>/config.json
  function saveConfig(c: Config, baseDir?: string): void;  // mkdirs baseDir
  function loadConfig(baseDir?: string): Config;
  ```

- [ ] **Step 1: Update `tests/config.test.ts`** (replace the cwd-based tests)

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, loadConfig, configPath } from "../src/config.js";

describe("config (global)", () => {
  it("round-trips a config through a base dir, creating it", () => {
    const base = join(mkdtempSync(join(tmpdir(), "cm-")), "nested");
    const cfg = { postgresUrl: "postgres://x", namespace: "husnain", captureMode: "auto" as const, embeddings: { provider: "none" as const } };
    saveConfig(cfg, base);
    expect(loadConfig(base)).toEqual(cfg);
    expect(configPath(base)).toBe(join(base, "config.json"));
  });

  it("throws a clear error when missing", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    expect(() => loadConfig(base)).toThrow(/not found.*claude-memory init/i);
  });

  it("throws a clear error when the config is invalid", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "config.json"), JSON.stringify({ namespace: "x" }));
    expect(() => loadConfig(base)).toThrow(/invalid config.*claude-memory init/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `captureMode` not in schema / signature mismatch.

- [ ] **Step 3: Rewrite `src/config.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const ConfigSchema = z.object({
  postgresUrl: z.string().min(1),
  namespace: z.string().min(1),
  captureMode: z.enum(["auto", "manual"]),
  embeddings: z.object({ provider: z.literal("none") }),
});
export type Config = z.infer<typeof ConfigSchema>;

export function configPath(baseDir = join(homedir(), ".claude-memory")): string {
  return join(baseDir, "config.json");
}

export function saveConfig(c: Config, baseDir?: string): void {
  const p = configPath(baseDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ConfigSchema.parse(c), null, 2));
}

export function loadConfig(baseDir?: string): Config {
  const p = configPath(baseDir);
  if (!existsSync(p)) {
    throw new Error(`Config not found at ${p}. Run 'claude-memory init' first.`);
  }
  const result = ConfigSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid config at ${p}: ${issues}. Re-run 'claude-memory init'.`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: global config path and captureMode field"
```

---

### Task 2: User-scope MCP registration

**Files:**
- Create: `src/wizard/register-mcp.ts`
- Create: `tests/register-mcp.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type McpRunner = (file: string, args: string[]) => void;
  function registerUserMcp(command: string, args: string[], run?: McpRunner): void;
  // runs: claude mcp remove --scope user claude-memory   (errors ignored)
  //       claude mcp add    --scope user claude-memory -- <command> <args...>
  ```

- [ ] **Step 1: Write the failing test `tests/register-mcp.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { registerUserMcp } from "../src/wizard/register-mcp.js";

describe("registerUserMcp", () => {
  it("removes then adds the server at user scope with the right argv", () => {
    const calls: Array<[string, string[]]> = [];
    registerUserMcp("claude-memory", ["serve"], (file, args) => { calls.push([file, args]); });
    expect(calls).toEqual([
      ["claude", ["mcp", "remove", "--scope", "user", "claude-memory"]],
      ["claude", ["mcp", "add", "--scope", "user", "claude-memory", "--", "claude-memory", "serve"]],
    ]);
  });

  it("ignores a failing remove but still runs add", () => {
    const calls: string[][] = [];
    registerUserMcp("claude-memory", ["serve"], (file, args) => {
      if (args[1] === "remove") throw new Error("not found");
      calls.push([file, ...args]);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("add");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/register-mcp.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/wizard/register-mcp.ts`**

```ts
import { execFileSync } from "node:child_process";

export type McpRunner = (file: string, args: string[]) => void;

const defaultRun: McpRunner = (file, args) => {
  execFileSync(file, args, { stdio: "inherit" });
};

export function registerUserMcp(command: string, args: string[], run: McpRunner = defaultRun): void {
  // Make registration idempotent: drop any prior entry, then add fresh.
  try {
    run("claude", ["mcp", "remove", "--scope", "user", "claude-memory"]);
  } catch {
    // no prior entry — fine
  }
  run("claude", ["mcp", "add", "--scope", "user", "claude-memory", "--", command, ...args]);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/register-mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wizard/register-mcp.ts tests/register-mcp.test.ts
git commit -m "feat: register MCP server at user scope via claude mcp add"
```

---

### Task 3: Auto-capture snippet manager

**Files:**
- Create: `src/wizard/capture-snippet.ts`
- Create: `tests/capture-snippet.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function applyCaptureSnippet(claudeMdPath: string, mode: "auto" | "manual"): void;
  // auto  -> upsert a marked managed block (idempotent), preserving surrounding content
  // manual-> remove the block if present, preserving surrounding content
  ```

- [ ] **Step 1: Write the failing test `tests/capture-snippet.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCaptureSnippet } from "../src/wizard/capture-snippet.js";

const MARK = /claude-memory:auto-capture/g;

describe("applyCaptureSnippet", () => {
  it("auto adds exactly one managed block to a new file", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "sub", "CLAUDE.md");
    applyCaptureSnippet(p, "auto");
    const text = readFileSync(p, "utf8");
    expect(text).toMatch(/auto-capture START/);
    expect(text.match(MARK)?.length).toBe(2); // START + END markers
  });

  it("auto is idempotent (re-running does not duplicate the block)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "CLAUDE.md");
    applyCaptureSnippet(p, "auto");
    applyCaptureSnippet(p, "auto");
    expect(readFileSync(p, "utf8").match(/auto-capture START/g)?.length).toBe(1);
  });

  it("preserves user content and removes the block on manual", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "CLAUDE.md");
    writeFileSync(p, "# My notes\n\nkeep me\n");
    applyCaptureSnippet(p, "auto");
    expect(readFileSync(p, "utf8")).toContain("keep me");
    applyCaptureSnippet(p, "manual");
    const text = readFileSync(p, "utf8");
    expect(text).toContain("keep me");
    expect(text).not.toMatch(MARK);
  });

  it("manual on a nonexistent file does not create one", () => {
    const p = join(mkdtempSync(join(tmpdir(), "cm-")), "none", "CLAUDE.md");
    applyCaptureSnippet(p, "manual");
    expect(existsSync(p)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/capture-snippet.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/wizard/capture-snippet.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const START = "<!-- claude-memory:auto-capture START -->";
const END = "<!-- claude-memory:auto-capture END -->";

const SNIPPET = `## Long-term memory (claude-memory)

Proactively maintain long-term memory using the claude-memory MCP tools, without being asked:
- Call \`remember\` when you learn a durable fact about the user, their projects, preferences, decisions, or environment.
- Call \`supersede\` when a remembered fact changes; \`forget\` when it is no longer true.
- Keep memories concise and factual. Never save secrets or transient details.
- At the start of relevant work, \`recall\` what you already know.`;

function stripBlock(text: string): string {
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s === -1 || e === -1 || e < s) return text;
  const before = text.slice(0, s).replace(/\n+$/, "");
  const after = text.slice(e + END.length).replace(/^\n+/, "");
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

export function applyCaptureSnippet(claudeMdPath: string, mode: "auto" | "manual"): void {
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";

  if (mode === "manual") {
    if (!existsSync(claudeMdPath)) return; // don't create a file just to have nothing to remove
    const stripped = stripBlock(existing);
    writeFileSync(claudeMdPath, stripped.trim() ? `${stripped.replace(/\n+$/, "")}\n` : "");
    return;
  }

  const base = stripBlock(existing).replace(/\n+$/, "");
  const block = `${START}\n${SNIPPET}\n${END}`;
  const next = base ? `${base}\n\n${block}\n` : `${block}\n`;
  mkdirSync(dirname(claudeMdPath), { recursive: true });
  writeFileSync(claudeMdPath, next);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/capture-snippet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wizard/capture-snippet.ts tests/capture-snippet.test.ts
git commit -m "feat: idempotent auto-capture snippet in global CLAUDE.md"
```

---

### Task 4: Rewire init wizard to global scope + capture mode

**Files:**
- Modify: `src/wizard/init.ts`
- Modify: `tests/init.test.ts`
- Delete: `src/wizard/mcp-config.ts`, `tests/mcp-config.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `saveConfig` (Task 1), `registerUserMcp` (Task 2), `applyCaptureSnippet` (Task 3), `migrate`.
- Produces:
  ```ts
  function runInitWith(deps: {
    prompt: (q: string) => Promise<string>;
    connect: (url: string) => Promise<import("pg").Pool>;
    configDir: string;
    claudeMdPath: string;
    registerMcp: (command: string, args: string[]) => void;
  }): Promise<void>;
  function runInit(): void;
  ```

- [ ] **Step 1: Replace `tests/init.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { runInitWith } from "../src/wizard/init.js";

let container: StartedPostgreSqlContainer;
beforeAll(async () => { container = await new PostgreSqlContainer("postgres:16").start(); });
afterAll(async () => { await container.stop(); });

describe("runInitWith (global + capture)", () => {
  it("auto: writes global config, registers user MCP, applies snippet, migrates db", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const configDir = join(base, "cfg");
    const claudeMdPath = join(base, "claude", "CLAUDE.md");
    const url = container.getConnectionUri();
    const answers = [url, "husnain", "auto"];
    let i = 0;
    const mcpCalls: Array<[string, string[]]> = [];

    await runInitWith({
      prompt: async () => answers[i++],
      connect: async (u) => new Pool({ connectionString: u }),
      configDir,
      claudeMdPath,
      registerMcp: (command, args) => { mcpCalls.push([command, args]); },
    });

    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.namespace).toBe("husnain");
    expect(cfg.captureMode).toBe("auto");
    expect(cfg.embeddings.provider).toBe("none");
    expect(mcpCalls).toEqual([["claude-memory", ["serve"]]]);
    expect(readFileSync(claudeMdPath, "utf8")).toMatch(/auto-capture START/);

    const pool = new Pool({ connectionString: url });
    const { rows } = await pool.query("select to_regclass('public.memories') as t");
    expect(rows[0].t).toBe("memories");
    await pool.end();
  });

  it("manual: writes no auto-capture snippet", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-"));
    const configDir = join(base, "cfg");
    const claudeMdPath = join(base, "claude", "CLAUDE.md");
    const url = container.getConnectionUri();
    const answers = [url, "husnain", "manual"];
    let i = 0;

    await runInitWith({
      prompt: async () => answers[i++],
      connect: async (u) => new Pool({ connectionString: u }),
      configDir, claudeMdPath,
      registerMcp: () => {},
    });

    const cfg = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(cfg.captureMode).toBe("manual");
    const md = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : "";
    expect(md).not.toMatch(/auto-capture/);
  });
});
```

- [ ] **Step 2: Delete the superseded project-scope writer and run the init test to confirm it fails**

```bash
git rm src/wizard/mcp-config.ts tests/mcp-config.test.ts
```
Run: `npx vitest run tests/init.test.ts`
Expected: FAIL — `runInitWith` signature mismatch (no `configDir`/`registerMcp` yet).

- [ ] **Step 3: Rewrite `src/wizard/init.ts`**

```ts
import { join } from "node:path";
import { homedir } from "node:os";
import { Pool } from "pg";
import * as p from "@clack/prompts";
import { saveConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { registerUserMcp } from "./register-mcp.js";
import { applyCaptureSnippet } from "./capture-snippet.js";

export async function runInitWith(deps: {
  prompt: (q: string) => Promise<string>;
  connect: (url: string) => Promise<Pool>;
  configDir: string;
  claudeMdPath: string;
  registerMcp: (command: string, args: string[]) => void;
}): Promise<void> {
  const postgresUrl = (await deps.prompt("Postgres connection string")).trim();
  const namespace = (await deps.prompt("Namespace (your identity, shared across machines)")).trim();
  const captureRaw = (await deps.prompt("Capture mode — 'auto' (save silently) or 'manual' [auto]")).trim().toLowerCase();
  const captureMode = captureRaw === "manual" ? "manual" : "auto";

  const pool = await deps.connect(postgresUrl);
  await migrate(pool);
  await pool.end();

  saveConfig({ postgresUrl, namespace, captureMode, embeddings: { provider: "none" } }, deps.configDir);
  deps.registerMcp("claude-memory", ["serve"]);
  applyCaptureSnippet(deps.claudeMdPath, captureMode);
}

export function runInit(): void {
  (async () => {
    p.intro("claude-memory init");
    await runInitWith({
      connect: async (url) => new Pool({ connectionString: url }),
      configDir: join(homedir(), ".claude-memory"),
      claudeMdPath: join(homedir(), ".claude", "CLAUDE.md"),
      registerMcp: (command, args) => registerUserMcp(command, args),
      prompt: async (q) => {
        const v = await p.text({ message: q });
        if (p.isCancel(v)) { p.cancel("Aborted."); process.exit(1); }
        return v as string;
      },
    });
    p.outro("Done. Restart Claude Code — memory tools are available in every project.");
  })().catch((err) => {
    p.cancel(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the init test to confirm it passes**

Run: `npx vitest run tests/init.test.ts`
Expected: PASS (both auto + manual cases).

- [ ] **Step 5: Update `README.md` Usage section**

Replace the existing Usage code block + the "Add a second machine" line with:

```markdown
## Usage

```bash
npx claude-memory init     # global setup: Postgres URL + namespace + capture mode
# registers the MCP server at USER scope — memory tools work in EVERY project
# restart Claude Code
```

The wizard asks for a **capture mode**:
- **auto** (default) — Claude saves and updates memories silently as you work; you issue no commands.
- **manual** — Claude only saves when you ask. Manual `remember`/`forget` work in both modes.

Add another machine by running the same `init` with the **same Postgres URL, namespace, and capture mode** — all machines share one brain.
```

- [ ] **Step 6: Full gate**

Run: `npm test && npm run build && npm run typecheck`
Expected: all PASS. (No references to the deleted `mcp-config` remain.)

- [ ] **Step 7: Commit**

```bash
git add src/wizard/init.ts tests/init.test.ts README.md
git commit -m "feat: global-scope wizard with auto/manual capture mode"
```

---

## Self-Review

**Spec coverage (M3b):**
- Global config location (§6c) → Task 1. ✓
- User-scope MCP registration (§6c, §9 step 6) → Task 2 + Task 4. ✓
- Capture mode auto/manual, wizard-selectable, default auto, manual always available (§6b) → Task 1 (field) + Task 3 (snippet) + Task 4 (prompt). ✓
- Idempotent CLAUDE.md block preserving user content (Global Constraints) → Task 3. ✓
- Project-level artifacts removed → Task 4 deletes `mcp-config.ts`. ✓
- No LLM dependency → none added. ✓

**Placeholder scan:** every code step shows full code; no TBD/"handle errors"/"similar to".

**Type consistency:** `Config` (with `captureMode`) consistent across Tasks 1/4; `configPath/saveConfig/loadConfig(baseDir)` signatures consistent (Task 1 ↔ Task 4 via `configDir`); `registerUserMcp(command, args, run?)` (Task 2) matches the `registerMcp(command, args)` dep injected in Task 4; `applyCaptureSnippet(path, mode)` consistent (Task 3 ↔ Task 4).

**Note for executor:** `serve()` in `src/mcp/server.ts` calls `loadConfig()` with no argument — after Task 1 that resolves to the global `~/.claude-memory/config.json`, which is the intended behavior; no change to `server.ts` needed. Tasks 1/4 require Docker (testcontainers).

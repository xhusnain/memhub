import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type ClientKey = "claude" | "codex" | "gemini" | "opencode" | "openclaw" | "cursor";
export type Run = (file: string, args: string[]) => void;
export type Which = (bin: string) => boolean;

const defaultRun: Run = (file, args) => {
  execFileSync(file, args, { stdio: "inherit" });
};

const defaultWhich: Which = (bin) => {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} exists but is not valid JSON — fix it and re-run memhub init`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${path} is not a JSON object — fix it and re-run memhub init`);
  }
  return parsed;
}

function objAt(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const v = parent[key];
  if (v === undefined) return {};
  if (!isPlainObject(v)) {
    throw new Error(`${path}: "${key}" is not a JSON object — fix it and re-run memhub init`);
  }
  return { ...v };
}

function writeJson(path: string, obj: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function jsonMergeFile(path: string, mutate: (obj: Record<string, unknown>) => void): void {
  const obj = readJsonObject(path);
  mutate(obj);
  writeJson(path, obj);
}

function jsonDeleteEntry(path: string, del: (obj: Record<string, unknown>) => void): void {
  if (!existsSync(path)) return;
  let obj: Record<string, unknown>;
  try {
    obj = readJsonObject(path);
  } catch {
    return;
  }
  del(obj);
  writeJson(path, obj);
}

const HOOK_PREFIX = "memhub hook ";
const CLAUDE_HOOKS: [string, string][] = [
  ["SessionStart", "session-start"],
  ["UserPromptSubmit", "prompt"],
  ["PreCompact", "pre-compact"],
  ["SessionEnd", "session-end"],
];

function isMemhubHook(h: unknown): boolean {
  return isPlainObject(h) && typeof h.command === "string" && h.command.startsWith(HOOK_PREFIX);
}

function stripMemhubHooks(o: Record<string, unknown>): void {
  if (!isPlainObject(o.hooks)) return;
  const hooks = o.hooks;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => (isPlainObject(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isMemhubHook(h)) } : g))
      .filter((g) => !(isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete o.hooks;
}

function installClaudeHooks(home: string): void {
  const path = join(home, ".claude", "settings.json");
  jsonMergeFile(path, (o) => {
    stripMemhubHooks(o);
    const hooks = objAt(o, "hooks", path);
    for (const [event, arg] of CLAUDE_HOOKS) {
      const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
      groups.push({ hooks: [{ type: "command", command: HOOK_PREFIX + arg, timeout: 10 }] });
      hooks[event] = groups;
    }
    o.hooks = hooks;
  });
}

function claudeHooksInstalled(home: string): boolean {
  let o: Record<string, unknown>;
  try { o = readJsonObject(join(home, ".claude", "settings.json")); } catch { return false; }
  const hooks = isPlainObject(o.hooks) ? o.hooks : {};
  return CLAUDE_HOOKS.every(([event, arg]) => {
    const groups = hooks[event];
    return Array.isArray(groups) && groups.some((g) =>
      isPlainObject(g) && Array.isArray(g.hooks) &&
      g.hooks.some((h) => isPlainObject(h) && h.command === HOOK_PREFIX + arg));
  });
}

function removeClaudeHooks(home: string): void {
  jsonDeleteEntry(join(home, ".claude", "settings.json"), stripMemhubHooks);
}

export type ClientAdapter = {
  key: ClientKey;
  title: string;
  bins: string[];
  configDir(home: string): string;
  instructionsFile(home: string): string | null;
  register(home: string, run: Run): void;
  unregister(home: string, run: Run): void;
  installHooks?(home: string): void;
  removeHooks?(home: string): void;
  hooksInstalled?(home: string): boolean;
};

export const CLIENTS: ClientAdapter[] = [
  {
    key: "claude",
    title: "Claude Code",
    bins: ["claude"],
    configDir: (home) => join(home, ".claude"),
    instructionsFile: (home) => join(home, ".claude", "CLAUDE.md"),
    register: (_home, run) => {
      try {
        run("claude", ["mcp", "remove", "--scope", "user", "memhub"]);
      } catch {}
      run("claude", ["mcp", "add", "--scope", "user", "--env", "MEMHUB_CLIENT=claude", "memhub", "--", "memhub", "serve"]);
    },
    unregister: (_home, run) => {
      try {
        run("claude", ["mcp", "remove", "--scope", "user", "memhub"]);
      } catch {}
    },
    installHooks: installClaudeHooks,
    removeHooks: removeClaudeHooks,
    hooksInstalled: claudeHooksInstalled,
  },
  {
    key: "codex",
    title: "Codex CLI",
    bins: ["codex"],
    configDir: (home) => join(home, ".codex"),
    instructionsFile: (home) => join(home, ".codex", "AGENTS.md"),
    register: (_home, run) => {
      try {
        run("codex", ["mcp", "remove", "memhub"]);
      } catch {}
      run("codex", ["mcp", "add", "memhub", "--env", "MEMHUB_CLIENT=codex", "--", "memhub", "serve"]);
    },
    unregister: (_home, run) => {
      try {
        run("codex", ["mcp", "remove", "memhub"]);
      } catch {}
    },
  },
  {
    key: "gemini",
    title: "Gemini CLI",
    bins: ["gemini"],
    configDir: (home) => join(home, ".gemini"),
    instructionsFile: (home) => join(home, ".gemini", "GEMINI.md"),
    register: (home) => {
      const path = join(home, ".gemini", "settings.json");
      jsonMergeFile(path, (o) => {
        const servers = objAt(o, "mcpServers", path);
        servers.memhub = { command: "memhub", args: ["serve"], env: { MEMHUB_CLIENT: "gemini" } };
        o.mcpServers = servers;
      });
    },
    unregister: (home) => {
      jsonDeleteEntry(join(home, ".gemini", "settings.json"), (o) => {
        if (isPlainObject(o.mcpServers)) delete o.mcpServers.memhub;
      });
    },
  },
  {
    key: "opencode",
    title: "opencode",
    bins: ["opencode"],
    configDir: (home) => join(home, ".config", "opencode"),
    instructionsFile: (home) => join(home, ".config", "opencode", "AGENTS.md"),
    register: (home) => {
      const path = join(home, ".config", "opencode", "opencode.json");
      jsonMergeFile(path, (o) => {
        const mcp = objAt(o, "mcp", path);
        mcp.memhub = { type: "local", command: ["memhub", "serve"], enabled: true, environment: { MEMHUB_CLIENT: "opencode" } };
        o.mcp = mcp;
      });
    },
    unregister: (home) => {
      jsonDeleteEntry(join(home, ".config", "opencode", "opencode.json"), (o) => {
        if (isPlainObject(o.mcp)) delete o.mcp.memhub;
      });
    },
  },
  {
    key: "openclaw",
    title: "OpenClaw",
    bins: ["openclaw"],
    configDir: (home) => join(home, ".openclaw"),
    instructionsFile: (home) => join(home, ".openclaw", "workspace", "AGENTS.md"),
    register: (home) => {
      const path = join(home, ".openclaw", "openclaw.json");
      jsonMergeFile(path, (o) => {
        const mcp = objAt(o, "mcp", path);
        const servers = objAt(mcp, "servers", path);
        servers.memhub = { command: "memhub", args: ["serve"] };
        mcp.servers = servers;
        o.mcp = mcp;
      });
    },
    unregister: (home) => {
      jsonDeleteEntry(join(home, ".openclaw", "openclaw.json"), (o) => {
        if (isPlainObject(o.mcp) && isPlainObject(o.mcp.servers)) delete o.mcp.servers.memhub;
      });
    },
  },
  {
    key: "cursor",
    title: "Cursor",
    bins: ["cursor-agent", "agent", "cursor"],
    configDir: (home) => join(home, ".cursor"),
    instructionsFile: () => null,
    register: (home) => {
      const path = join(home, ".cursor", "mcp.json");
      jsonMergeFile(path, (o) => {
        const servers = objAt(o, "mcpServers", path);
        servers.memhub = { command: "memhub", args: ["serve"], env: { MEMHUB_CLIENT: "cursor" } };
        o.mcpServers = servers;
      });
    },
    unregister: (home) => {
      jsonDeleteEntry(join(home, ".cursor", "mcp.json"), (o) => {
        if (isPlainObject(o.mcpServers)) delete o.mcpServers.memhub;
      });
    },
  },
];

export function clientByKey(key: string): ClientAdapter | undefined {
  return CLIENTS.find((c) => c.key === key);
}

export function detectClients(home: string, which: Which = defaultWhich): ClientKey[] {
  return CLIENTS.filter((c) => existsSync(c.configDir(home)) || c.bins.some(which)).map((c) => c.key);
}

export function registerClient(key: string, home: string, run: Run = defaultRun): void {
  const adapter = clientByKey(key);
  if (!adapter) throw new Error(`Unknown client: ${key}`);
  adapter.register(home, run);
}

export function unregisterClient(key: string, home: string, run: Run = defaultRun): void {
  const adapter = clientByKey(key);
  if (!adapter) throw new Error(`Unknown client: ${key}`);
  adapter.unregister(home, run);
}

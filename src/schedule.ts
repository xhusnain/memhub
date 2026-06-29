import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

// Resolve the directories that contain `memhub` and `claude`, so the scheduled
// job's PATH can find both (cron/launchd start with a minimal PATH).
export function resolveBins(): { memhubPath: string; pathDirs: string[] } {
  const nodeBinDir = dirname(process.execPath); // nvm: node + global bins colocated
  const candidates = [
    nodeBinDir,
    join(homedir(), ".local", "bin"),     // claude default (Linux/mac)
    "/opt/homebrew/bin",                  // mac (Apple silicon Homebrew)
    "/usr/local/bin",                     // mac (Intel Homebrew) / linux
  ];
  const which = (bin: string): string | null => {
    try { return execFileSync("which", [bin], { encoding: "utf8" }).trim().split("\n")[0] || null; }
    catch { return null; }
  };
  const memhubPath = which("memhub") || join(nodeBinDir, "memhub");
  const claudePath = which("claude");
  const dirs = new Set<string>([nodeBinDir]);
  if (claudePath) dirs.add(dirname(claudePath));
  for (const c of candidates) if (existsSync(c)) dirs.add(c);
  return { memhubPath, pathDirs: [...dirs] };
}

export function buildCronLine(opts: { schedule?: string; pathDirs?: string[]; logPath?: string }): string {
  const schedule = opts.schedule ?? "0 3 * * *";
  const log = opts.logPath ?? "$HOME/.memhub/dream.log";
  const pathPrefix = opts.pathDirs && opts.pathDirs.length ? `PATH=${opts.pathDirs.join(":")}:$PATH ` : "";
  return `${schedule} ${pathPrefix}memhub dream >> ${log} 2>&1`;
}

export function buildLaunchdPlist(opts: { memhubPath: string; pathDirs: string[]; logPath: string; hour?: number; minute?: number; label?: string }): string {
  const label = opts.label ?? "com.memhub.dream";
  const hour = opts.hour ?? 3;
  const minute = opts.minute ?? 0;
  const pathEnv = [...opts.pathDirs, "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.memhubPath}</string>
    <string>dream</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${pathEnv}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${opts.logPath}</string>
  <key>StandardErrorPath</key><string>${opts.logPath}</string>
</dict>
</plist>
`;
}

const PLIST_PATH = () => join(homedir(), "Library", "LaunchAgents", "com.memhub.dream.plist");
const LOG_PATH = () => join(homedir(), ".memhub", "dream.log");

export function printSchedule(): void {
  const { memhubPath, pathDirs } = resolveBins();
  if (platform() === "darwin") {
    console.log("# macOS (launchd). Save this to:\n#   " + PLIST_PATH() + "\n# then run:\n#   launchctl load " + PLIST_PATH() + "\n");
    console.log(buildLaunchdPlist({ memhubPath, pathDirs, logPath: LOG_PATH() }));
    console.log("# Or just run:  memhub schedule --install");
  } else {
    console.log("# Linux/cron. Add to your crontab (crontab -e):\n");
    console.log(buildCronLine({ pathDirs }));
    console.log("\n# Or just run:  memhub schedule --install");
  }
}

export function installSchedule(): void {
  const { memhubPath, pathDirs } = resolveBins();
  mkdirSync(join(homedir(), ".memhub"), { recursive: true });
  if (platform() === "darwin") {
    const p = PLIST_PATH();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buildLaunchdPlist({ memhubPath, pathDirs, logPath: LOG_PATH() }));
    try { execFileSync("launchctl", ["unload", p], { stdio: "ignore" }); } catch { /* not loaded */ }
    execFileSync("launchctl", ["load", p], { stdio: "inherit" });
    console.log(`Installed launchd agent → ${p} (runs nightly at 03:00; log: ${LOG_PATH()})`);
  } else {
    const line = buildCronLine({ pathDirs });
    let existing = "";
    try { existing = execFileSync("crontab", ["-l"], { encoding: "utf8" }); } catch { /* no crontab yet */ }
    const kept = existing.split("\n").filter((l) => l && !l.includes("memhub dream")).join("\n");
    const next = (kept ? kept + "\n" : "") + line + "\n";
    execFileSync("crontab", ["-"], { input: next });
    console.log(`Installed cron job (runs nightly at 03:00; log: ${LOG_PATH()}):\n  ${line}`);
  }
}

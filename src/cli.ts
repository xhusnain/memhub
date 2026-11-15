import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { redactErr } from "./redact.js";

const CONNECT_ATTEMPT_MS = 5000;
setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);

const [, , command] = process.argv;

const USAGE = `memhub — a personal memory for your AI CLIs

Setup
  memhub init [--yes] [--url <postgres-url>]   set up or change settings (--yes: no questions)
  memhub doctor                                check that everything is wired correctly

Look at your memory
  memhub stats                                 how much is stored
  memhub list [--kind preference] [--status faded] [--limit 20]
  memhub recall <words> [--deep]               search as the agent does
  memhub history <id>                          how one memory changed

Maintenance
  memhub reflect                               learn from finished sessions now
  memhub dream                                 run the consolidation pass now
  memhub schedule [--install]                  nightly dream
  memhub db <start|stop|status>                the local database, if you use one`;

async function main() {
  switch (command) {
    case "init":
      (await import("./wizard/init.js")).runInit(process.argv.slice(3));
      break;
    case "serve":
      (await import("./mcp/server.js")).serve();
      break;
    case "dream": {
      const mod = await import("./dream.js");
      if (process.argv.includes("--print-cron")) (await import("./schedule.js")).printSchedule();
      else mod.runDream();
      break;
    }
    case "schedule": {
      const mod = await import("./schedule.js");
      if (process.argv.includes("--install")) mod.installSchedule();
      else mod.printSchedule();
      break;
    }
    case "reflect":
      (await import("./reflect.js")).runReflect();
      break;
    case "hook":
      await (await import("./hooks.js")).runHook(process.argv[3], process.argv.includes("--json"));
      break;
    case "recall":
    case "list":
    case "history":
    case "stats":
      await (await import("./inspect.js")).runInspect(command, process.argv.slice(3));
      break;
    case "doctor":
      await (await import("./doctor.js")).runDoctor();
      break;
    case "db":
      await (await import("./doctor.js")).runDb(process.argv[3]);
      break;
    case "--version":
    case "-v":
      console.log((await import("./version.js")).VERSION);
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}
main().catch((err) => {
  console.error(redactErr(err));
  process.exit(1);
});

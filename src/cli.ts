import { redactUrl } from "./redact.js";

const [, , command] = process.argv;

async function main() {
  switch (command) {
    case "init":
      (await import("./wizard/init.js")).runInit();
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
    default:
      console.log("Usage: memhub <init|serve|dream|schedule>");
      process.exit(command ? 1 : 0);
  }
}
main().catch((err) => {
  console.error(redactUrl(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});

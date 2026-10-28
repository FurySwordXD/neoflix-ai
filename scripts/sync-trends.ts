/**
 * Turn news-scraper's trending Topics into stories: classify new trends,
 * then create or refresh their stories in the shared graph.
 *
 *   npm run sync:trends            one cycle (same as --once)
 *   npm run sync:trends -- --loop  a cycle every SYNC_INTERVAL_MINUTES (default 30)
 *
 * Needs STORY_STORE=neo4j, NEO4J_URI, NEO4J_PASSWORD and NEBIUS_API_KEY.
 * Ctrl-C stops after aborting the story in progress; a second Ctrl-C exits at once.
 */
import fs from "fs";
import path from "path";
import { storeKindFromEnv } from "../src/lib/stories";
import { closeDriver } from "../src/lib/storyStore/neo4j";
import { syncSettingsFromEnv, type SyncSettings } from "../src/lib/trendSync/config";
import { runCycle } from "../src/lib/trendSync/decide";
import { graphConnectionFromEnv, type GraphConnection } from "../src/lib/trendSync/graph";
import { createCycleDeps } from "../src/lib/trendSync/worker";

type Mode = "once" | "loop";

class ConfigError extends Error {}

function parseMode(args: string[]): Mode {
  const unknown = args.filter((arg) => arg !== "--once" && arg !== "--loop");
  if (unknown.length > 0) throw new ConfigError(`Unknown argument ${unknown.join(" ")} (use --once or --loop).`);
  if (args.includes("--once") && args.includes("--loop")) throw new ConfigError("Pass --once or --loop, not both.");
  return args.includes("--loop") ? "loop" : "once";
}

function loadConfig(): { mode: Mode; settings: SyncSettings; conn: GraphConnection } {
  const envFile = path.join(process.cwd(), ".env");
  // Variables already set in the shell win over .env.
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const mode = parseMode(process.argv.slice(2));
  if (storeKindFromEnv() !== "neo4j") {
    throw new ConfigError("needs STORY_STORE=neo4j (it reads trends from and writes stories to the graph).");
  }
  if (!process.env.NEBIUS_API_KEY) throw new ConfigError("needs NEBIUS_API_KEY to be set.");
  const settings = syncSettingsFromEnv();
  const conn = graphConnectionFromEnv();
  if (!conn) throw new ConfigError("could not connect to Neo4j.");
  return { mode, settings, conn };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function cycleOnce(conn: GraphConnection, settings: SyncSettings, signal: AbortSignal): Promise<boolean> {
  try {
    const summary = await runCycle(createCycleDeps(conn, settings, signal));
    return summary.failed === 0;
  } catch (err) {
    // The cycle itself failed (graph down, say); the loop tries again next interval.
    console.error("sync: cycle failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`sync:trends: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  const { mode, settings, conn } = config;

  const controller = new AbortController();
  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(130);
    console.log("sync: stopping (Ctrl-C again to force)");
    controller.abort();
  });

  try {
    if (mode === "once") {
      if (!(await cycleOnce(conn, settings, controller.signal))) process.exitCode = 1;
      return;
    }
    console.log(`sync: looping every ${settings.intervalMinutes} min`);
    while (!controller.signal.aborted) {
      await cycleOnce(conn, settings, controller.signal);
      await wait(settings.intervalMinutes * 60_000, controller.signal);
    }
  } finally {
    await closeDriver();
  }
}

void main();

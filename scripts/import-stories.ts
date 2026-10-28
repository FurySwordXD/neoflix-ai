/**
 * Copy the JSON stories under src/data/stories into Neo4j. Safe to re-run:
 * stories already in the graph are skipped.
 *
 *   npm run graph:import
 */
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../src/lib/stories";
import { createFileStore } from "../src/lib/storyStore/fileStore";
import { importStories } from "../src/lib/storyStore/importStories";
import { closeDriver, getDriver, neo4jConfigFromEnv } from "../src/lib/storyStore/neo4j";
import { createNeo4jStore } from "../src/lib/storyStore/neo4jStore";

async function main(): Promise<void> {
  const envFile = path.join(process.cwd(), ".env");
  // Variables already set in the shell win over .env.
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const config = neo4jConfigFromEnv();
  const target = createNeo4jStore({ driver: getDriver(config), database: config.database });
  try {
    const { imported, skipped } = await importStories(createFileStore(DATA_DIR), target);
    console.log(`Imported ${imported} ${imported === 1 ? "story" : "stories"} into Neo4j (${skipped} already there).`);
  } finally {
    await closeDriver();
  }
}

main().catch((err: unknown) => {
  console.error("graph:import failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

import type { Driver } from "neo4j-driver";
import { storeKindFromEnv } from "../stories";
import { getDriver, neo4jConfigFromEnv } from "../storyStore/neo4j";

type Env = Record<string, string | undefined>;

export interface GraphConnection {
  driver: Driver;
  database?: string;
}

/** The shared graph, or null in file mode. Throws when neo4j is selected but not configured. */
export function graphConnectionFromEnv(env: Env = process.env): GraphConnection | null {
  if (storeKindFromEnv(env) !== "neo4j") return null;
  const config = neo4jConfigFromEnv(env);
  return { driver: getDriver(config), database: config.database };
}

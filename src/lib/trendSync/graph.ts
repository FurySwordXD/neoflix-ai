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

const LINK = `
MATCH (s:Story {slug: $slug}) WHERE s.createdAt IS NOT NULL
MATCH (t:Topic {key: $key})
MERGE (s)-[:ABOUT]->(t)
RETURN s.slug AS slug
`;

/** MERGE (Story)-[:ABOUT]->(Topic). Throws if either node is missing, instead of creating stubs. */
export async function linkStoryToTopic(conn: GraphConnection, slug: string, key: string): Promise<void> {
  const { records } = await conn.driver.executeQuery(LINK, { slug, key }, { database: conn.database });
  if (records.length === 0) throw new Error(`cannot link story "${slug}" to topic "${key}": one of them is missing`);
}

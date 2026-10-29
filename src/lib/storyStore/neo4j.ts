import neo4j, { type Driver } from "neo4j-driver";

/**
 * Connection to the Neo4j graph shared with news-scraper. One driver per
 * process, cached on globalThis so dev hot reloads do not leak connections.
 */

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
  /** Unset means the server's default database. */
  database?: string;
}

type Env = Record<string, string | undefined>;

const SCHEMA_STATEMENTS = [
  "CREATE CONSTRAINT story_slug IF NOT EXISTS FOR (n:Story) REQUIRE n.slug IS UNIQUE",
  "CREATE CONSTRAINT event_key IF NOT EXISTS FOR (n:Event) REQUIRE n.key IS UNIQUE",
];

const cache = globalThis as unknown as {
  __neoflixNeo4jDriver?: Driver;
  __neoflixNeo4jSchema?: WeakMap<Driver, Promise<void>>;
};

/** Reads NEO4J_URI, NEO4J_USER (default "neo4j"), NEO4J_PASSWORD and NEO4J_DATABASE. */
export function neo4jConfigFromEnv(env: Env = process.env): Neo4jConfig {
  const uri = env.NEO4J_URI?.trim();
  const password = env.NEO4J_PASSWORD;
  const missing = [!uri && "NEO4J_URI", !password && "NEO4J_PASSWORD"].filter(Boolean);
  if (!uri || !password) {
    throw new Error(
      `STORY_STORE=neo4j needs ${missing.join(" and ")} to be set (see .env.example).`
    );
  }
  const database = env.NEO4J_DATABASE?.trim();
  return {
    uri,
    user: env.NEO4J_USER?.trim() || "neo4j",
    password,
    ...(database ? { database } : {}),
  };
}

/** The process-wide driver. The first call's config wins until `closeDriver()`. */
export function getDriver(config: Neo4jConfig = neo4jConfigFromEnv()): Driver {
  if (!cache.__neoflixNeo4jDriver) {
    cache.__neoflixNeo4jDriver = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.user, config.password),
      { disableLosslessIntegers: true }
    );
  }
  return cache.__neoflixNeo4jDriver;
}

export async function closeDriver(): Promise<void> {
  const driver = cache.__neoflixNeo4jDriver;
  cache.__neoflixNeo4jDriver = undefined;
  await driver?.close();
}

/** Creates the Story.slug and Event.key unique constraints, once per driver. */
export function ensureSchema(driver: Driver, database?: string): Promise<void> {
  const done = (cache.__neoflixNeo4jSchema ??= new WeakMap());
  let pending = done.get(driver);
  if (!pending) {
    pending = applySchema(driver, database).catch((err: unknown) => {
      // Let the next call retry instead of caching the failure.
      done.delete(driver);
      throw err;
    });
    done.set(driver, pending);
  }
  return pending;
}

async function applySchema(driver: Driver, database?: string): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await driver.executeQuery(statement, {}, { database });
  }
}

/** Topic key shared with news-scraper's `normalize_key`: lowercased, whitespace collapsed. */
export function topicKey(name: string): string {
  return name.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** "reuters.com" for "https://www.reuters.com/x", matching news-scraper's Source.domain. */
export function sourceDomain(url: string): string {
  try {
    return (new URL(url).hostname || "unknown").toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

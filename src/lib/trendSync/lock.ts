import { randomUUID } from "crypto";
import type { Driver } from "neo4j-driver";
import { topicKey } from "../storyStore/neo4j";
import type { GraphConnection } from "./graph";

/**
 * (:GenerationLock {key, holder, until}) leases in the shared graph, so the
 * sync worker and a reader's request never generate the same story at once.
 * A lease expires on its own at `until`, so a crashed holder cannot block a
 * key for longer than its ttl.
 */

export interface Lease {
  key: string;
  holder: string;
  /** Frees the lease if this holder still has it. */
  release: () => Promise<void>;
}

const LOCK_CONSTRAINT =
  "CREATE CONSTRAINT generation_lock_key IF NOT EXISTS FOR (n:GenerationLock) REQUIRE n.key IS UNIQUE";

// The first SET takes the node's write lock before `until` is read, so two
// callers racing on one key are serialized and only one sees it free.
const ACQUIRE = `
MERGE (l:GenerationLock {key: $key})
SET l.touchedAt = datetime()
WITH l
WHERE l.until IS NULL OR l.until < datetime() OR l.holder = $holder
SET l.until = datetime() + duration({seconds: $ttl}), l.holder = $holder
RETURN l.holder AS holder
`;

const RELEASE = "MATCH (l:GenerationLock {key: $key, holder: $holder}) DELETE l";

const schemaCache = globalThis as unknown as { __neoflixLockSchema?: WeakMap<Driver, Promise<void>> };

function ensureLockSchema({ driver, database }: GraphConnection): Promise<void> {
  const done = (schemaCache.__neoflixLockSchema ??= new WeakMap());
  let pending = done.get(driver);
  if (!pending) {
    pending = driver
      .executeQuery(LOCK_CONSTRAINT, {}, { database })
      .then(() => undefined)
      .catch((err: unknown) => {
        done.delete(driver);
        throw err;
      });
    done.set(driver, pending);
  }
  return pending;
}

/** "story:<topic key of the query>", the lease a story generation takes. */
export function storyLockKey(query: string): string {
  return `story:${topicKey(query)}`;
}

/** Takes the lease for `ttlSeconds`, or returns null while someone else holds it. */
export async function acquireLease(
  conn: GraphConnection,
  key: string,
  ttlSeconds: number,
  holder: string = randomUUID()
): Promise<Lease | null> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`Lease ttl must be a whole number of seconds above 0 (got ${ttlSeconds}).`);
  }
  await ensureLockSchema(conn);
  const { records } = await conn.driver.executeQuery(
    ACQUIRE,
    { key, holder, ttl: ttlSeconds },
    { database: conn.database }
  );
  if (records.length === 0) return null;
  return {
    key,
    holder,
    release: async () => {
      await conn.driver.executeQuery(RELEASE, { key, holder }, { database: conn.database });
    },
  };
}

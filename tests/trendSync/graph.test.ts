import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNeo4jStore } from "@/lib/storyStore/neo4jStore";
import { markTopicsSynced, saveClassifications } from "@/lib/trendSync/classify";
import { linkStoryToTopic } from "@/lib/trendSync/graph";
import type { GraphConnection } from "@/lib/trendSync/graph";
import { acquireLease } from "@/lib/trendSync/lock";
import { loadCandidates } from "@/lib/trendSync/selection";
import { makeStory } from "../storyStore/fixtures";

let container: StartedNeo4jContainer;
let driver: Driver;
let conn: GraphConnection;

const NOW = new Date("2026-10-28T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

beforeAll(async () => {
  container = await new Neo4jContainer("neo4j:5.26").withPassword("test-password").start();
  driver = neo4j.driver(
    container.getBoltUri(),
    neo4j.auth.basic(container.getUsername(), container.getPassword()),
    { disableLosslessIntegers: true }
  );
  conn = { driver };
}, 180_000);

afterAll(async () => {
  await driver?.close();
  await container?.stop();
});

beforeEach(async () => {
  await driver.executeQuery("MATCH (n) DETACH DELETE n");
});

interface SeedTopic {
  name: string;
  /** [days ago, traffic_value or null] per TRENDED edge. */
  trends: Array<[number, number | null]>;
  checkedDaysAgo?: number;
  worthy?: boolean;
  query?: string;
  category?: string;
  /** Store TRENDED.at as a LocalDateTime, as a naive Python datetime would. */
  localAt?: boolean;
  /** When the worker last acted on it successfully. */
  syncedDaysAgo?: number;
}

/** Writes a Topic the way news-scraper's record_trend does, plus optional worker bookkeeping. */
async function seedTopic(topic: SeedTopic) {
  const key = topic.name.toLowerCase();
  for (const [days, value] of topic.trends) {
    const at = daysAgo(days);
    await driver.executeQuery(
      `MERGE (t:Topic {key: $key}) ON CREATE SET t.name = $name
       MERGE (g:Geo {code: 'US'})
       MERGE (t)-[r:TRENDED {at: CASE WHEN $localAt THEN localdatetime(datetime($at)) ELSE datetime($at) END}]->(g)
       SET r.traffic = toString($value) + '+', r.traffic_value = $value`,
      { key, name: topic.name, at, value, localAt: topic.localAt ?? false }
    );
  }
  if (topic.checkedDaysAgo !== undefined) {
    await driver.executeQuery(
      `MATCH (t:Topic {key: $key})
       SET t.story_checked_at = datetime($checked), t.story_worthy = $worthy,
           t.story_query = $query, t.story_category = $category`,
      {
        key,
        checked: daysAgo(topic.checkedDaysAgo),
        worthy: topic.worthy ?? false,
        query: topic.query ?? null,
        category: topic.category ?? null,
      }
    );
  }
  if (topic.syncedDaysAgo !== undefined) {
    await driver.executeQuery(`MATCH (t:Topic {key: $key}) SET t.story_synced_at = datetime($synced)`, {
      key,
      synced: daysAgo(topic.syncedDaysAgo),
    });
  }
}

/** An Article ABOUT a Topic, the way news-scraper writes it. */
async function seedArticle(topicName: string, url: string, title: string | null, seenDaysAgo: number) {
  await driver.executeQuery(
    `MATCH (t:Topic {key: $key})
     MERGE (a:Article {url: $url}) SET a.title = $title, a.seen_at = datetime($seen)
     MERGE (a)-[:ABOUT]->(t)`,
    { key: topicName.toLowerCase(), url, title, seen: daysAgo(seenDaysAgo) }
  );
}

describe("loadCandidates", () => {
  it("returns never-checked topics above the floor, highest traffic first", async () => {
    await seedTopic({ name: "Small", trends: [[1, 2000]] });
    await seedTopic({ name: "Big", trends: [[2, 9000], [1, 100]] });
    await seedTopic({ name: "Tiny", trends: [[1, 500]] });
    const found = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found.map((c) => [c.name, c.traffic])).toEqual([
      ["Big", 9000],
      ["Small", 2000],
    ]);
    expect(found[0]).toMatchObject({ key: "big", cached: null, latestAt: daysAgo(1), headlines: [] });
  });

  it("lets topics without traffic_value through only when the floor is 0", async () => {
    await seedTopic({ name: "Unknown traffic", trends: [[1, null]] });
    expect(await loadCandidates(conn, { trafficFloor: 1000, now: NOW })).toEqual([]);
    const found = await loadCandidates(conn, { trafficFloor: 0, now: NOW });
    expect(found.map((c) => [c.name, c.traffic])).toEqual([["Unknown traffic", null]]);
  });

  it("skips topics that have not trended since they were checked", async () => {
    await seedTopic({ name: "Stale", trends: [[3, 5000]], checkedDaysAgo: 2, worthy: true, query: "Stale", syncedDaysAgo: 2 });
    await seedTopic({ name: "Stale no", trends: [[3, 5000]], checkedDaysAgo: 2, worthy: false });
    expect(await loadCandidates(conn, { trafficFloor: 1000, now: NOW })).toEqual([]);
  });

  it("retries a worthy topic whose story action never succeeded", async () => {
    await seedTopic({ name: "Unsynced", trends: [[3, 5000]], checkedDaysAgo: 2, worthy: true, query: "Unsynced q" });
    const found = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found.map((c) => [c.name, c.cached])).toEqual([
      ["Unsynced", { worthy: true, query: "Unsynced q", category: null }],
    ]);
  });

  it("returns a synced worthy topic again once it trends after the sync", async () => {
    await seedTopic({ name: "Again", trends: [[1, 5000]], checkedDaysAgo: 3, worthy: true, query: "Again", syncedDaysAgo: 2 });
    const found = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found.map((c) => c.name)).toEqual(["Again"]);
  });

  it("carries up to 3 of the topic's most recent headlines with their source domain", async () => {
    await seedTopic({ name: "Wind farm", trends: [[1, 5000]] });
    await seedArticle("Wind farm", "https://www.bbc.co.uk/news/1", "Offshore wind farm approved", 1);
    await seedArticle("Wind farm", "https://reuters.com/2", "Wind farm project cancelled", 0.5);
    await seedArticle("Wind farm", "https://apnews.com/3", "Turbines halted after collapse", 2);
    await seedArticle("Wind farm", "https://old.example/4", "Wind farm history", 9);
    await seedArticle("Wind farm", "https://notitle.example/5", null, 0.1);
    const [found] = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found.headlines).toEqual([
      { title: "Wind farm project cancelled", source: "reuters.com" },
      { title: "Offshore wind farm approved", source: "bbc.co.uk" },
      { title: "Turbines halted after collapse", source: "apnews.com" },
    ]);
  });

  it("gives a topic without articles no headlines", async () => {
    await seedTopic({ name: "Lonely", trends: [[1, 5000]] });
    const [found] = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found.headlines).toEqual([]);
  });

  it("re-checks a non-worthy topic only after 7 days", async () => {
    await seedTopic({ name: "Recent no", trends: [[1, 5000]], checkedDaysAgo: 3, worthy: false });
    await seedTopic({ name: "Old no", trends: [[1, 5000]], checkedDaysAgo: 8, worthy: false });
    const found = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found.map((c) => [c.name, c.cached])).toEqual([["Old no", null]]);
  });

  it("returns a re-trending worthy topic with its cached classification while it is under 7 days old", async () => {
    await seedTopic({
      name: "Brexit deal",
      trends: [[1, 5000]],
      checkedDaysAgo: 3,
      worthy: true,
      query: "Brexit deal talks",
      category: "politics",
    });
    await seedTopic({ name: "Old yes", trends: [[1, 4000]], checkedDaysAgo: 9, worthy: true, query: "Old yes" });
    const found = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found.map((c) => [c.name, c.cached])).toEqual([
      ["Brexit deal", { worthy: true, query: "Brexit deal talks", category: "politics" }],
      ["Old yes", null],
    ]);
  });

  it("reads TRENDED.at stored as a LocalDateTime", async () => {
    await seedTopic({ name: "Naive", trends: [[1, 5000]], localAt: true });
    const found = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found.map((c) => c.name)).toEqual(["Naive"]);
  });

  it("caps the batch at 25", async () => {
    await driver.executeQuery(
      `UNWIND range(1, 30) AS i
       MERGE (t:Topic {key: 'topic ' + i}) SET t.name = 'Topic ' + i
       MERGE (g:Geo {code: 'US'})
       MERGE (t)-[:TRENDED {at: datetime($at), traffic_value: 1000 + i}]->(g)`,
      { at: daysAgo(1) }
    );
    const found = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(found).toHaveLength(25);
    expect(found[0].name).toBe("Topic 30");
  });
});

describe("saveClassifications", () => {
  it("stores the worker's bookkeeping on each Topic, so it is not selected again", async () => {
    await seedTopic({ name: "Gaza ceasefire", trends: [[1, 5000]] });
    await seedTopic({ name: "Lakers score", trends: [[1, 5000]] });
    await saveClassifications(
      conn,
      [
        { key: "gaza ceasefire", name: "Gaza ceasefire", worthy: true, query: "Gaza ceasefire talks", category: "conflict" },
        { key: "lakers score", name: "Lakers score", worthy: false, query: null, category: null },
      ],
      NOW
    );
    const { records } = await driver.executeQuery(
      `MATCH (t:Topic) RETURN t.key AS key, t.story_worthy AS worthy, t.story_query AS query,
              t.story_category AS category, toString(t.story_checked_at) AS checked ORDER BY key`
    );
    expect(records.map((r) => r.toObject())).toEqual([
      { key: "gaza ceasefire", worthy: true, query: "Gaza ceasefire talks", category: "conflict", checked: "2026-10-28T12:00:00Z" },
      { key: "lakers score", worthy: false, query: null, category: null, checked: "2026-10-28T12:00:00Z" },
    ]);
    // The worthy topic stays selected (cached) until its story action succeeds.
    const pending = await loadCandidates(conn, { trafficFloor: 1000, now: NOW });
    expect(pending.map((c) => [c.key, c.cached?.query])).toEqual([["gaza ceasefire", "Gaza ceasefire talks"]]);
  });

  it("does not set story_synced_at", async () => {
    await seedTopic({ name: "Gaza ceasefire", trends: [[1, 5000]] });
    await saveClassifications(
      conn,
      [{ key: "gaza ceasefire", name: "Gaza ceasefire", worthy: true, query: "q", category: "conflict" }],
      NOW
    );
    const { records } = await driver.executeQuery(`MATCH (t:Topic) RETURN t.story_synced_at AS synced`);
    expect(records[0].get("synced")).toBeNull();
  });
});

describe("markTopicsSynced", () => {
  it("stops selecting a worthy topic until it trends again", async () => {
    await seedTopic({ name: "Gaza ceasefire", trends: [[1, 5000]], checkedDaysAgo: 0, worthy: true, query: "q" });
    await markTopicsSynced(conn, ["gaza ceasefire"], NOW);
    expect(await loadCandidates(conn, { trafficFloor: 1000, now: NOW })).toEqual([]);
    const { records } = await driver.executeQuery(`MATCH (t:Topic) RETURN toString(t.story_synced_at) AS synced`);
    expect(records[0].get("synced")).toBe("2026-10-28T12:00:00Z");
  });

  it("does nothing for an empty list", async () => {
    await expect(markTopicsSynced(conn, [], NOW)).resolves.toBeUndefined();
  });

  it("does nothing for an empty list", async () => {
    await expect(saveClassifications(conn, [], NOW)).resolves.toBeUndefined();
  });
});

describe("linkStoryToTopic", () => {
  it("MERGEs one ABOUT edge from the Story to the Topic", async () => {
    await seedTopic({ name: "Alpha", trends: [[1, 5000]] });
    await createNeo4jStore({ driver }).saveNewStory(makeStory("alpha"));
    await linkStoryToTopic(conn, "alpha", "alpha");
    await linkStoryToTopic(conn, "alpha", "alpha");
    const { records } = await driver.executeQuery(
      "MATCH (:Story {slug: 'alpha'})-[r:ABOUT]->(:Topic {key: 'alpha'}) RETURN count(r) AS n"
    );
    expect(records[0].get("n")).toBe(1);
  });

  it("throws when the story or topic is missing instead of creating stubs", async () => {
    await expect(linkStoryToTopic(conn, "ghost", "nobody")).rejects.toThrow(/ghost/);
    const { records } = await driver.executeQuery("MATCH (n) RETURN count(n) AS n");
    expect(records[0].get("n")).toBe(0);
  });
});

describe("acquireLease", () => {
  it("grants the lease to exactly one of many concurrent callers", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireLease(conn, "story:race", 60)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const { records } = await driver.executeQuery("MATCH (l:GenerationLock {key: 'story:race'}) RETURN count(l) AS n");
    expect(records[0].get("n")).toBe(1);
  });

  it("refuses a held lease, and grants it again after release", async () => {
    const first = await acquireLease(conn, "story:a", 60);
    expect(first).not.toBeNull();
    expect(await acquireLease(conn, "story:a", 60)).toBeNull();
    await first!.release();
    const again = await acquireLease(conn, "story:a", 60);
    expect(again).not.toBeNull();
    expect(again!.holder).not.toBe(first!.holder);
  });

  it("grants an expired lease to a new holder", async () => {
    const first = await acquireLease(conn, "story:b", 60);
    await driver.executeQuery(
      "MATCH (l:GenerationLock {key: 'story:b'}) SET l.until = datetime() - duration({seconds: 1})"
    );
    const second = await acquireLease(conn, "story:b", 60);
    expect(second).not.toBeNull();
    // The old holder's late release must not free the new holder's lease.
    await first!.release();
    expect(await acquireLease(conn, "story:b", 60)).toBeNull();
  });

  it("keeps leases on different keys independent", async () => {
    expect(await acquireLease(conn, "story:x", 60)).not.toBeNull();
    expect(await acquireLease(conn, "story:y", 60)).not.toBeNull();
  });

  it("rejects a non-positive ttl", async () => {
    await expect(acquireLease(conn, "story:z", 0)).rejects.toThrow(/ttl/i);
  });
});

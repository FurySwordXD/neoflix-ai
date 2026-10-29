import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchArticleCoverage, fetchTrendRows } from "@/lib/trends";

let container: StartedNeo4jContainer;
let driver: Driver;

beforeAll(async () => {
  container = await new Neo4jContainer("neo4j:5.26").withPassword("test-password").start();
  driver = neo4j.driver(
    container.getBoltUri(),
    neo4j.auth.basic(container.getUsername(), container.getPassword()),
    { disableLosslessIntegers: true }
  );
}, 180_000);

afterAll(async () => {
  await driver?.close();
  await container?.stop();
});

/** The shape news-scraper (TRENDED, Geo) and the sync worker (story_*) write. */
async function seed() {
  await driver.executeQuery("MATCH (n) DETACH DELETE n");
  await driver.executeQuery(`
    CREATE (us:Geo {code: "US"}), (gb:Geo {code: "GB"})
    CREATE (mpox:Topic {key: "mpox outbreak", name: "Mpox outbreak", max_traffic: 200000,
                        story_worthy: true, story_query: "the 2026 mpox outbreak",
                        story_category: "health"})
    CREATE (mpox)-[:TRENDED {at: datetime("2026-10-28T08:00:00Z"), traffic: "50,000+", traffic_value: 50000}]->(us)
    CREATE (mpox)-[:TRENDED {at: datetime("2026-10-28T10:00:00Z"), traffic: "200,000+", traffic_value: 200000}]->(gb)
    CREATE (old:Topic {key: "old storm", name: "Old storm", story_worthy: true})
    CREATE (old)-[:TRENDED {at: "2026-10-20T10:00:00Z", traffic: "1K+"}]->(us)
    CREATE (score:Topic {key: "match score", name: "Match score", story_worthy: false})
    CREATE (score)-[:TRENDED {at: datetime("2026-10-28T11:00:00Z"), traffic_value: 900000}]->(us)
    CREATE (story:Story {slug: "mpox-outbreak", title: "The mpox outbreak", description: "How it spread.",
                         status: "ongoing", createdAt: "2026-10-27T00:00:00Z", refreshedAt: "2026-10-28T00:00:00Z"})
    CREATE (stub:Story {slug: "stub-story"})
    CREATE (story)-[:ABOUT]->(mpox)
    CREATE (stub)-[:ABOUT]->(old)
  `);
}

describe("fetchTrendRows", () => {
  it("reads worthy topics with their traffic, geos, latest trend and linked story", async () => {
    await seed();
    const rows = await fetchTrendRows(driver, 20);

    expect(rows.map((row) => row.key)).toEqual(["mpox outbreak", "old storm"]);
    const [mpox, old] = rows;
    expect(mpox).toMatchObject({
      name: "Mpox outbreak",
      query: "the 2026 mpox outbreak",
      category: "health",
      slug: "mpox-outbreak",
      storyTitle: "The mpox outbreak",
      storyDescription: "How it spread.",
      storyStatus: "ongoing",
      traffic: 200000,
      latestAtMs: Date.parse("2026-10-28T10:00:00Z"),
    });
    expect([...mpox.geos].sort()).toEqual(["GB", "US"]);
    // String timestamps parse too; the stub Story (no createdAt) is ignored.
    expect(old).toMatchObject({
      slug: null,
      traffic: null,
      latestAtMs: Date.parse("2026-10-20T10:00:00Z"),
    });
  });

  it("honors the limit", async () => {
    await seed();
    const rows = await fetchTrendRows(driver, 1);
    expect(rows.map((row) => row.key)).toEqual(["mpox outbreak"]);
  });
});

describe("fetchArticleCoverage", () => {
  it("maps each saved story to the newest article its events cite", async () => {
    await seed();
    await driver.executeQuery(`
      MATCH (s:Story {slug: "mpox-outbreak"})
      CREATE (e1:Event {key: "mpox-outbreak/e01"}), (e2:Event {key: "mpox-outbreak/e02"})
      CREATE (s)-[:HAS_EVENT]->(e1), (s)-[:HAS_EVENT]->(e2)
      CREATE (e1)-[:CITES]->(:Article {url: "https://a.example/1", published: "2026-10-26T00:00:00Z"})
      CREATE (e2)-[:CITES]->(:Article {url: "https://a.example/2", published: "2026-10-28T00:00:00Z"})
    `);
    const coverage = await fetchArticleCoverage(driver);
    expect(coverage).toEqual({ "mpox-outbreak": Date.parse("2026-10-28T00:00:00Z") });
  });

  it("skips stub stories and articles with no publish date", async () => {
    await seed();
    await driver.executeQuery(`
      MATCH (stub:Story {slug: "stub-story"})
      CREATE (stub)-[:HAS_EVENT]->(:Event {key: "stub-story/e01"})
             -[:CITES]->(:Article {url: "https://b.example/1", published: "2026-10-28T00:00:00Z"})
    `);
    expect(await fetchArticleCoverage(driver)).toEqual({});
  });
});

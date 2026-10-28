import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileEventImages } from "@/lib/eventImages";
import { graphSearch, persistSearchResults, researchQuery, type GraphResearchOptions } from "@/lib/graphResearch";
import { collectImageUrls, type WebSearchResponse } from "@/lib/webSearch";

let container: StartedNeo4jContainer;
let driver: Driver;

const NOW = new Date("2026-10-28T12:00:00.000Z");
const DAY_MS = 86_400_000;
const NEO4J_ENV = { STORY_STORE: "neo4j" };

/** The indexes and constraint news-scraper creates (src/graph/repository.py). */
const SCRAPER_SCHEMA = [
  "CREATE CONSTRAINT article_url IF NOT EXISTS FOR (n:Article) REQUIRE n.url IS UNIQUE",
  "CREATE FULLTEXT INDEX article_text IF NOT EXISTS FOR (n:Article) ON EACH [n.title, n.summary] " +
    "OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
  "CREATE FULLTEXT INDEX name_text IF NOT EXISTS FOR (n:Topic|Entity) ON EACH [n.name] " +
    "OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
];

/** Every image decodes unless a test says otherwise; no network in tests. */
const acceptAll = async (urls: string[]) => new Set(urls);

function options(overrides: Partial<GraphResearchOptions> = {}): GraphResearchOptions {
  return { env: NEO4J_ENV, driver, now: NOW, verifyImages: acceptAll, ...overrides };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

interface SeedArticle {
  url: string;
  title: string;
  summary?: string;
  image?: string;
  published?: string;
  /** ISO time stored as a Neo4j DateTime, as news-scraper writes it. Omit for none. */
  seenAt?: string;
  provider?: string;
}

async function seedArticle(article: SeedArticle) {
  await driver.executeQuery(
    `MERGE (a:Article {url: $url})
     SET a.title = $title, a.summary = $summary, a.image = $image, a.published = $published,
         a.provider = $provider,
         a.seen_at = CASE WHEN $seenAt IS NULL THEN null ELSE datetime($seenAt) END,
         a.scraped_at = CASE WHEN $seenAt IS NULL THEN null ELSE datetime($seenAt) END`,
    {
      summary: null,
      image: null,
      published: null,
      seenAt: null,
      provider: "google_news",
      ...article,
    }
  );
}

async function articleProps(url: string): Promise<Record<string, unknown> | null> {
  const { records } = await driver.executeQuery(
    `MATCH (a:Article {url: $url})
     OPTIONAL MATCH (a)-[:PUBLISHED_BY]->(s:Source)
     RETURN a {.title, .summary, .published, .image, .provider,
               seen_at: toString(a.seen_at), scraped_at: toString(a.scraped_at),
               seen_type: valueType(a.seen_at)} AS a,
            collect(s.domain) AS domains`,
    { url }
  );
  if (records.length === 0) return null;
  return { ...records[0].get("a"), domains: records[0].get("domains") };
}

beforeAll(async () => {
  container = await new Neo4jContainer("neo4j:5.26").withPassword("test-password").start();
  driver = neo4j.driver(
    container.getBoltUri(),
    neo4j.auth.basic(container.getUsername(), container.getPassword()),
    { disableLosslessIntegers: true }
  );
  for (const statement of SCRAPER_SCHEMA) await driver.executeQuery(statement);
  await driver.executeQuery("CALL db.awaitIndexes(120)");
}, 180_000);

afterAll(async () => {
  await driver?.close();
  await container?.stop();
});

beforeEach(async () => {
  await driver.executeQuery("MATCH (n) DETACH DELETE n");
});

describe("graphSearch", () => {
  it("finds fresh articles by title or summary and maps them to search results", async () => {
    await seedArticle({
      url: "https://www.reuters.com/world/election-1",
      title: "Election results announced",
      summary: "The national election ended with a narrow win.",
      image: "https://cdn.reuters.com/election.jpg",
      published: "2026-10-27",
      seenAt: daysAgo(1),
    });
    await seedArticle({ url: "https://x.com/cooking", title: "Pasta recipes", seenAt: daysAgo(1) });

    const found = await graphSearch("elections", options());

    expect(found.images).toEqual([]);
    expect(found.results).toEqual([
      {
        title: "Election results announced",
        url: "https://www.reuters.com/world/election-1",
        snippet: "The national election ended with a narrow win.",
        date: "2026-10-27",
        image: "https://cdn.reuters.com/election.jpg",
      },
    ]);
  });

  it("finds articles through the Topic and Entity name index", async () => {
    await seedArticle({ url: "https://a.com/1", title: "Talks resume", seenAt: daysAgo(2) });
    await seedArticle({ url: "https://a.com/2", title: "Markets rally", seenAt: daysAgo(2) });
    await driver.executeQuery(`
      MATCH (a1:Article {url: "https://a.com/1"}), (a2:Article {url: "https://a.com/2"})
      MERGE (t:Topic {key: "gaza ceasefire"}) SET t.name = "Gaza ceasefire"
      MERGE (e:Entity {key: "hamas"}) SET e.name = "Hamas", e.type = "ORG"
      MERGE (a1)-[:ABOUT]->(t)
      MERGE (a2)-[:MENTIONS]->(e)`);

    expect((await graphSearch("ceasefire", options())).results.map((r) => r.url)).toEqual([
      "https://a.com/1",
    ]);
    expect((await graphSearch("Hamas", options())).results.map((r) => r.url)).toEqual([
      "https://a.com/2",
    ]);
  });

  it("drops articles older than GRAPH_FRESH_DAYS", async () => {
    await seedArticle({ url: "https://a.com/new", title: "Storm warning", seenAt: daysAgo(2) });
    await seedArticle({ url: "https://a.com/old", title: "Storm damage", seenAt: daysAgo(40) });

    const defaults = await graphSearch("storm", options());
    const tight = await graphSearch("storm", options({ env: { ...NEO4J_ENV, GRAPH_FRESH_DAYS: "1" } }));

    expect(defaults.results.map((r) => r.url)).toEqual(["https://a.com/new"]);
    expect(tight.results).toEqual([]);
  });

  it("judges articles without seen_at by their published date", async () => {
    await seedArticle({ url: "https://a.com/recent", title: "Flood relief", published: daysAgo(3) });
    await seedArticle({ url: "https://a.com/archive", title: "Flood history", published: "2008-09-15" });
    await seedArticle({ url: "https://a.com/undated", title: "Flood maps" });

    const found = await graphSearch("flood", options());

    expect(found.results.map((r) => r.url)).toEqual(["https://a.com/recent"]);
  });

  it("returns at most 8 results", async () => {
    for (let i = 0; i < 12; i++) {
      await seedArticle({ url: `https://a.com/${i}`, title: `Budget vote ${i}`, seenAt: daysAgo(1) });
    }
    expect((await graphSearch("budget", options())).results).toHaveLength(8);
  });

  it("matches Lucene special characters literally instead of failing", async () => {
    await seedArticle({ url: "https://a.com/cpp", title: "C++ (2026) release: what's new?", seenAt: daysAgo(1) });

    const found = await graphSearch('C++ (2026) release: "new"?', options());

    expect(found.results.map((r) => r.url)).toEqual(["https://a.com/cpp"]);
    await expect(graphSearch("&& || ! ~ *", options())).resolves.toEqual({ results: [], images: [] });
  });

  it("drops images that do not decode or are not http(s)", async () => {
    await seedArticle({ url: "https://a.com/1", title: "Quake hits", image: "https://img.com/ok.jpg", seenAt: daysAgo(1) });
    await seedArticle({ url: "https://a.com/2", title: "Quake aftershock", image: "https://img.com/broken.jpg", seenAt: daysAgo(1) });
    await seedArticle({ url: "https://a.com/3", title: "Quake relief", image: "ftp://img.com/x.jpg", seenAt: daysAgo(1) });
    const checked: string[][] = [];
    const verifyImages = async (urls: string[]) => {
      checked.push(urls);
      return new Set(urls.filter((url) => url.endsWith("ok.jpg")));
    };

    const found = await graphSearch("quake", options({ verifyImages }));

    expect(checked).toEqual([expect.arrayContaining(["https://img.com/ok.jpg", "https://img.com/broken.jpg"])]);
    expect(checked[0]).toHaveLength(2);
    const images = Object.fromEntries(found.results.map((r) => [r.url, r.image]));
    expect(images).toEqual({
      "https://a.com/1": "https://img.com/ok.jpg",
      "https://a.com/2": undefined,
      "https://a.com/3": undefined,
    });
  });

  it("offers graph images to compileEventImages as harvested URLs", async () => {
    const image = "https://images.some-small-cdn.example/quake.jpg";
    await seedArticle({ url: "https://a.com/1", title: "Quake hits", image, seenAt: daysAgo(1) });

    const found = await graphSearch("quake", options());
    const allowed = new Set(collectImageUrls(found));

    expect(compileEventImages([{ url: image }], allowed)).toEqual([{ url: image }]);
    expect(compileEventImages([{ url: image }], new Set())).toEqual([]);
  });

  it("creates the full-text indexes itself when news-scraper has not run", async () => {
    await driver.executeQuery("DROP INDEX article_text IF EXISTS");
    await driver.executeQuery("DROP INDEX name_text IF EXISTS");
    const fresh = neo4j.driver(
      container.getBoltUri(),
      neo4j.auth.basic(container.getUsername(), container.getPassword()),
      { disableLosslessIntegers: true }
    );
    try {
      await expect(graphSearch("anything", options({ driver: fresh }))).resolves.toEqual({
        results: [],
        images: [],
      });
      const { records } = await driver.executeQuery(
        "SHOW FULLTEXT INDEXES YIELD name RETURN collect(name) AS names"
      );
      expect(records[0].get("names")).toEqual(expect.arrayContaining(["article_text", "name_text"]));
    } finally {
      await fresh.close();
    }
  });
});

describe("graphSearch precision", () => {
  /** Eight fresh articles that share only the word "wind" with the query, half via a Topic name. */
  async function seedSharedTermNoise() {
    const titles = [
      "Wind chill warning for the weekend",
      "Solar and wind output hits record",
      "Winds topple trees across the county",
      "Wind instruments return to the orchestra",
    ];
    for (const [i, title] of titles.entries()) {
      await seedArticle({ url: `https://noise.com/${i}`, title, seenAt: daysAgo(1) });
    }
    for (let i = 0; i < 4; i++) {
      await seedArticle({ url: `https://topic.com/${i}`, title: `Gusts expected, part ${i}`, seenAt: daysAgo(1) });
    }
    await driver.executeQuery(`
      MERGE (t:Topic {key: "wind"}) SET t.name = "Wind"
      WITH t MATCH (a:Article) WHERE a.url STARTS WITH "https://topic.com/" MERGE (a)-[:ABOUT]->(t)`);
  }

  it("no longer lets one shared term skip Tavily", async () => {
    await seedSharedTermNoise();
    const lines: string[] = [];
    const tavily = { results: [{ title: "Hornsea 4 offshore wind farm cancelled", url: "https://t.com/1", snippet: "" }], images: [] };
    const webSearch = async () => tavily;

    const found = await researchQuery("Hornsea offshore wind farm cancelled", {
      graphSearch: (query) => graphSearch(query, options()),
      webSearch,
      persist: async () => undefined,
      minHits: 5,
      log: (line) => lines.push(line),
      warn: () => undefined,
    });

    expect(lines).toEqual(["research: graph=0 tavily=used"]);
    expect(found.results.map((r) => r.url)).toEqual(["https://t.com/1"]);
  });

  it("still finds articles that contain every significant term, across title and summary", async () => {
    await seedSharedTermNoise();
    await seedArticle({
      url: "https://bbc.co.uk/hornsea",
      title: "Hornsea offshore wind farm scrapped",
      summary: "The developer said the project was cancelled over rising costs.",
      seenAt: daysAgo(1),
    });

    const found = await graphSearch("Hornsea offshore wind farm cancelled", options());

    expect(found.results.map((r) => r.url)).toEqual(["https://bbc.co.uk/hornsea"]);
  });

  it("finds articles through a Topic whose name holds every term", async () => {
    await seedArticle({ url: "https://a.com/wf", title: "Turbine plans approved", seenAt: daysAgo(1) });
    await seedArticle({ url: "https://a.com/w", title: "Storm gusts", seenAt: daysAgo(1) });
    await driver.executeQuery(`
      MATCH (a1:Article {url: "https://a.com/wf"}), (a2:Article {url: "https://a.com/w"})
      MERGE (t1:Topic {key: "wind farm"}) SET t1.name = "Wind farm"
      MERGE (t2:Topic {key: "wind"}) SET t2.name = "Wind"
      MERGE (a1)-[:ABOUT]->(t1)
      MERGE (a2)-[:ABOUT]->(t2)`);

    expect((await graphSearch("wind farm", options())).results.map((r) => r.url)).toEqual(["https://a.com/wf"]);
  });

  it("drops hits scoring under half of the best one", async () => {
    await seedArticle({ url: "https://a.com/strong", title: "Ceasefire ceasefire ceasefire", seenAt: daysAgo(1) });
    await seedArticle({
      url: "https://a.com/weak",
      title: "Weekly roundup",
      summary:
        "A long digest about markets, sport, culture, travel, food, science, music, film, weather, " +
        "politics and, in one line near the end, the ceasefire.",
      seenAt: daysAgo(1),
    });

    expect((await graphSearch("ceasefire", options())).results.map((r) => r.url)).toEqual(["https://a.com/strong"]);
  });
});

describe("persistSearchResults", () => {
  const tavily: WebSearchResponse = {
    results: [
      {
        title: "Ceasefire holds",
        url: "https://www.apnews.com/article/ceasefire",
        snippet: "A".repeat(1500),
        date: "2026-10-27",
        image: "https://img.apnews.com/ceasefire.jpg",
        imageAlt: "Crowds",
      },
      { title: "Talks continue", url: "https://bbc.co.uk/news/talks", snippet: "Delegates met." },
    ],
    images: [{ url: "https://img.com/pool.jpg" }],
  };

  it("writes Tavily results as Articles with a Source", async () => {
    await persistSearchResults(tavily, options());

    expect(await articleProps("https://www.apnews.com/article/ceasefire")).toEqual({
      title: "Ceasefire holds",
      summary: "A".repeat(1000),
      published: "2026-10-27",
      image: "https://img.apnews.com/ceasefire.jpg",
      provider: "tavily",
      seen_at: "2026-10-28T12:00:00Z",
      scraped_at: "2026-10-28T12:00:00Z",
      seen_type: "ZONED DATETIME NOT NULL",
      domains: ["apnews.com"],
    });
    expect(await articleProps("https://bbc.co.uk/news/talks")).toMatchObject({
      summary: "Delegates met.",
      published: null,
      image: null,
      domains: ["bbc.co.uk"],
    });
  });

  it("makes written articles findable by graphSearch", async () => {
    await persistSearchResults(tavily, options());
    const found = await graphSearch("ceasefire", options());
    expect(found.results.map((r) => r.url)).toEqual(["https://www.apnews.com/article/ceasefire"]);
  });

  it("is idempotent", async () => {
    await persistSearchResults(tavily, options());
    await persistSearchResults(tavily, options());
    const { records } = await driver.executeQuery(
      "MATCH (a:Article) OPTIONAL MATCH (a)-[p:PUBLISHED_BY]->() RETURN count(DISTINCT a) AS articles, count(p) AS links"
    );
    expect(records[0].get("articles")).toBe(2);
    expect(records[0].get("links")).toBe(2);
  });

  it("never overwrites what news-scraper wrote, but refreshes seen_at", async () => {
    await seedArticle({
      url: "https://www.apnews.com/article/ceasefire",
      title: "Scraper title",
      summary: "Scraper summary.",
      image: "https://img.apnews.com/scraper.jpg",
      published: "2026-10-20",
      seenAt: daysAgo(5),
      provider: "google_news",
    });

    await persistSearchResults(tavily, options());

    expect(await articleProps("https://www.apnews.com/article/ceasefire")).toMatchObject({
      title: "Scraper title",
      summary: "Scraper summary.",
      image: "https://img.apnews.com/scraper.jpg",
      published: "2026-10-20",
      provider: "google_news",
      seen_at: "2026-10-28T12:00:00Z",
      scraped_at: new Date(daysAgo(5)).toISOString().replace(".000Z", "Z"),
    });
  });

  it("fills in fields a stub Article is missing without touching the rest", async () => {
    // A story citation creates an Article with only title/published (no summary).
    await driver.executeQuery(
      `CREATE (:Article {url: "https://bbc.co.uk/news/talks", title: "Cited title", published: "2026-01-01"})`
    );

    await persistSearchResults(tavily, options());

    expect(await articleProps("https://bbc.co.uk/news/talks")).toMatchObject({
      title: "Cited title",
      summary: "Delegates met.",
      published: "2026-01-01",
      provider: "tavily",
      seen_at: "2026-10-28T12:00:00Z",
    });
  });

  it("skips results without an http(s) URL or a title", async () => {
    await persistSearchResults(
      {
        results: [
          { title: "No scheme", url: "javascript:alert(1)", snippet: "x" },
          { title: "", url: "https://a.com/untitled", snippet: "x" },
        ],
        images: [],
      },
      options()
    );
    const { records } = await driver.executeQuery("MATCH (a:Article) RETURN count(a) AS n");
    expect(records[0].get("n")).toBe(0);
  });
});

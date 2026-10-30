import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTrends } from "@/lib/scraper/ingest";
import { loadCandidates } from "@/lib/trendSync/selection";
import type { TrendItem } from "@/lib/scraper/trends";

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

const NOW = new Date("2026-10-29T12:00:00.000Z");

function trendItem(name: string, overrides: Partial<TrendItem> = {}): TrendItem {
  return {
    key: name.toLowerCase(),
    name,
    traffic: 50000,
    trafficLabel: "50,000+",
    at: NOW.toISOString(),
    geos: ["US"],
    headlines: [{ title: `${name} headline`, url: `https://reuters.com/${name.replace(/\s+/g, "-")}`, source: "Reuters" }],
    ...overrides,
  };
}

async function graph() {
  const { records } = await driver.executeQuery(
    `MATCH (t:Topic) OPTIONAL MATCH (t)-[r:TRENDED]->(g:Geo)
     OPTIONAL MATCH (a:Article)-[:ABOUT]->(t)
     RETURN t.key AS key, t.name AS name, t.max_traffic AS maxTraffic, r.at AS at,
            r.traffic AS traffic, r.traffic_value AS trafficValue, g.code AS geo,
            count(DISTINCT a) AS articles
     ORDER BY key, geo`
  );
  return records.map((r) => r.toObject());
}

describe("writeTrends", () => {
  it("writes Topics, TRENDED edges per geo and ABOUT-linked Articles", async () => {
    const summary = await writeTrends(
      driver,
      [
        trendItem("Mpox outbreak", { geos: ["US", "GB"], traffic: 200000, trafficLabel: "200,000+" }),
        trendItem("Storm Aldo", { headlines: [] }),
      ],
      { now: NOW }
    );
    expect(summary).toMatchObject({ topics: 2, trendEdges: 3, articles: 1 });

    const rows = await graph();
    expect(rows).toHaveLength(3); // 2 geos for mpox + 1 for the storm
    const [mpoxGB, mpoxUS, storm] = rows;
    expect(mpoxGB).toMatchObject({
      key: "mpox outbreak",
      name: "Mpox outbreak",
      maxTraffic: 200000,
      geo: "GB",
      trafficValue: 200000,
      traffic: "200,000+",
      articles: 1,
    });
    expect(mpoxUS).toMatchObject({ key: "mpox outbreak", geo: "US", trafficValue: 200000 });
    expect(storm).toMatchObject({ key: "storm aldo", name: "Storm Aldo", geo: "US", articles: 0 });
    // Edge timestamps land as DateTime the worker's candidates query reads.
    expect(String(mpoxUS.at)).toContain("2026-10-29T12:00:00Z");
  });

  it("is idempotent: a re-run does not double traffic or duplicate edges", async () => {
    await writeTrends(driver, [trendItem("Mpox outbreak")], { now: NOW });
    await writeTrends(driver, [trendItem("Mpox outbreak")], { now: NOW });
    const rows = await graph();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trafficValue: 50000, maxTraffic: 50000 });
    const { records } = await driver.executeQuery("MATCH (:Topic)-[r:TRENDED]->(:Geo) RETURN count(r) AS n");
    expect(records[0].get("n")).toBe(1);
  });

  it("keeps max traffic and never rewinds the trend timestamp", async () => {
    await writeTrends(driver, [trendItem("Big wave", { traffic: 90000, trafficLabel: "90,000+" })], { now: NOW });
    const earlier = new Date(NOW.getTime() - 3_600_000).toISOString();
    await writeTrends(driver, [trendItem("Big wave", { traffic: 1000, trafficLabel: "1,000+", at: earlier })], {
      now: new Date(NOW.getTime() + 1000),
    });
    const rows = await graph();
    expect(rows[0]).toMatchObject({ trafficValue: 90000, traffic: "90,000+" });
    expect(String(rows[0].at)).toContain("2026-10-29T12:00:00Z");
  });

  it("normalizes a pre-existing LocalDateTime TRENDED.at before comparing", async () => {
    // What a naive Python datetime (old news-scraper) lands as.
    await driver.executeQuery(
      `MERGE (t:Topic {key: 'old storm'}) SET t.name = 'Old storm'
       MERGE (g:Geo {code: 'US'})
       MERGE (t)-[r:TRENDED {at: localdatetime('2026-10-28T10:00:00'), traffic_value: 100}]->(g)`
    );
    await writeTrends(driver, [trendItem("Old storm", { traffic: 5000, trafficLabel: "5,000+" })], { now: NOW });
    const rows = await graph();
    expect(rows[0]).toMatchObject({ trafficValue: 5000 });
    expect(String(rows[0].at)).toContain("2026-10-29T12:00:00Z");
  });

  it("writes nothing for an empty batch", async () => {
    const summary = await writeTrends(driver, [], { now: NOW });
    expect(summary).toEqual({ topics: 0, trendEdges: 0, articles: 0, failedGeos: [] });
    const { records } = await driver.executeQuery("MATCH (n) RETURN count(n) AS n");
    expect(records[0].get("n")).toBe(0);
  });

  it("skips headlines whose Topic vanished between the upsert and the article write", async () => {
    // Simulate the race: the topic exists for the existence check, then is
    // gone by the time the article MERGE runs.
    const original = driver.executeQuery.bind(driver);
    const failing = ((query: string, params?: Record<string, unknown>, config?: object) =>
      query.includes("UNWIND $rows AS row")
      && query.includes("MATCH (t:Topic {key: row.key})")
        ? Promise.reject(new Error("topic deleted"))
        : original(query, params, config as never)) as typeof driver.executeQuery;
    driver.executeQuery = failing as typeof driver.executeQuery;
    await expect(writeTrends(driver, [trendItem("Ghost")], { now: NOW })).rejects.toThrow("topic deleted");
    driver.executeQuery = original;
  });
});

describe("scraped data feeds the sync worker", () => {
  it("a scraped topic above the floor becomes a sync candidate with headlines", async () => {
    await writeTrends(
      driver,
      [trendItem("Ceasefire talks", { traffic: 80000 })],
      { now: NOW }
    );
    const found = await loadCandidates({ driver }, { trafficFloor: 1000, now: NOW });
    expect(found.map((c) => [c.name, c.traffic])).toEqual([["Ceasefire talks", 80000]]);
    expect(found[0].headlines).toEqual([
      { title: "Ceasefire talks headline", source: "reuters.com" },
    ]);
  });
});

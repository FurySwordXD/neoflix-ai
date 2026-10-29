import fs from "fs";
import os from "os";
import path from "path";
import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileStore } from "@/lib/storyStore/fileStore";
import { ensureSchema } from "@/lib/storyStore/neo4j";
import { createNeo4jStore } from "@/lib/storyStore/neo4jStore";
import { runStoreContract } from "./contract";
import { makeStory } from "./fixtures";

let container: StartedNeo4jContainer;
let driver: Driver;
const tempDirs: string[] = [];

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
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function wipe() {
  await driver.executeQuery("MATCH (n) DETACH DELETE n");
}

runStoreContract("neo4j", () => ({
  fresh: async () => {
    await wipe();
    return createNeo4jStore({ driver });
  },
  freshSource: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neoflix-import-"));
    tempDirs.push(dir);
    return createFileStore(dir);
  },
}));

describe("neo4jStore graph shape", () => {
  it("creates the unique constraints", async () => {
    await ensureSchema(driver);
    const { records } = await driver.executeQuery(
      "SHOW CONSTRAINTS YIELD labelsOrTypes, properties, type RETURN labelsOrTypes[0] AS label, properties[0] AS prop, type"
    );
    const found = records.map((r) => `${r.get("label")}.${r.get("prop")}:${r.get("type")}`);
    expect(found).toContain("Story.slug:UNIQUENESS");
    expect(found).toContain("Event.key:UNIQUENESS");
  });

  it("writes Story, Event, Article, Source and RELATED_STORY per the graph contract", async () => {
    await wipe();
    const store = createNeo4jStore({ driver });
    await store.saveNewStory(makeStory("alpha"));

    const { records } = await driver.executeQuery(`
      MATCH (s:Story {slug: "alpha"})-[:HAS_EVENT]->(e:Event {key: "alpha/e02"})
      MATCH (e)-[c:CITES]->(a:Article)-[:PUBLISHED_BY]->(src:Source)
      MATCH (s)-[r:RELATED_STORY]->(other:Story)
      RETURN s, e, c, a, src, r, other`);
    expect(records).toHaveLength(1);
    const rec = records[0];
    const story = rec.get("s").properties;
    expect(typeof story.createdAt).toBe("string");
    expect(typeof story.refreshedAt).toBe("string");
    const event = rec.get("e").properties;
    expect(event).toMatchObject({ id: "e02", place: "Geneva", country: "Switzerland", lat: 46.2044, lng: 6.1432 });
    expect(JSON.parse(event.motion)).toMatchObject({ kind: "flow" });
    expect(JSON.parse(event.images)).toHaveLength(1);
    const cites = rec.get("c").properties;
    expect(cites.order).toBe(0);
    expect(JSON.parse(cites.bias)).toEqual({ politicalLean: "center", factualRating: "high", note: "Wire service" });
    expect(cites.corroborates).toEqual(["the main claim"]);
    expect(rec.get("a").properties).toMatchObject({ url: "https://www.reuters.com/world/e02", title: "Reuters on e02" });
    expect(rec.get("src").properties.domain).toBe("reuters.com");
    expect(rec.get("r").properties.relation).toBe("Came after it.");
    expect(rec.get("other").properties.slug).toBe("other-story");
  });

  it("shares one Article per URL and never overwrites scraped article fields", async () => {
    await wipe();
    await driver.executeQuery(
      `CREATE (:Article {url: "https://www.reuters.com/world/e01", title: "Scraped title", provider: "firecrawl"})`
    );
    const store = createNeo4jStore({ driver });
    await store.saveNewStory(makeStory("alpha"));
    await store.saveNewStory(makeStory("beta"));

    const { records } = await driver.executeQuery(
      `MATCH (a:Article {url: "https://www.reuters.com/world/e01"}) OPTIONAL MATCH (a)<-[c:CITES]-()
       RETURN a.title AS title, a.provider AS provider, a.publisher AS publisher, count(c) AS cites`
    );
    expect(records).toHaveLength(1);
    expect(records[0].get("title")).toBe("Scraped title");
    expect(records[0].get("provider")).toBe("firecrawl");
    expect(records[0].get("publisher")).toBe("Reuters");
    expect(records[0].get("cites")).toBe(2);
    // The story still reads the title its source was cited with.
    expect((await store.getStory("alpha"))?.events[0].sources[0].title).toBe("Reuters on e01");
  });

  it("only counts a related-story stub as a story once it is saved", async () => {
    await wipe();
    const store = createNeo4jStore({ driver });
    await store.saveNewStory(makeStory("alpha"));
    expect(await store.getStory("other-story")).toBeNull();
    const saved = await store.saveNewStory(makeStory("other-story", { relatedStories: [] }));
    expect(saved.slug).toBe("other-story");
    expect((await store.getStory("other-story"))?.title).toBe("Story other-story");
  });

  it("updates refreshedAt when events are appended", async () => {
    await wipe();
    const store = createNeo4jStore({ driver });
    await store.saveNewStory(makeStory("alpha"));
    const before = (await store.listStoryMetas())[0].refreshedAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.appendStoryEvents("alpha", []);
    const after = (await store.listStoryMetas())[0].refreshedAt;
    expect(after && before && after > before).toBe(true);
  });

  it("deleteStory leaves a bare stub and keeps shared articles and incoming related-story edges", async () => {
    await wipe();
    const store = createNeo4jStore({ driver });
    await store.saveNewStory(makeStory("alpha"));
    await store.saveNewStory(makeStory("beta"));
    // gamma points at alpha, so alpha gains an incoming RELATED_STORY edge
    // that a delete must not touch (only outgoing ones go).
    await store.saveNewStory(
      makeStory("gamma", {
        relatedStories: [{ slug: "alpha", title: "Story alpha", relation: "Came before it." }],
      })
    );

    await store.deleteStory("alpha");

    // The Story node survives as a stub: slug only, no save properties.
    const { records: storyRecords } = await driver.executeQuery(
      'MATCH (s:Story {slug: "alpha"}) RETURN properties(s) AS props'
    );
    expect(storyRecords).toHaveLength(1);
    const props = storyRecords[0].get("props") as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(["slug"]);

    // Its events and outgoing RELATED_STORY edges are gone.
    const { records: eventRecords } = await driver.executeQuery(
      'MATCH (:Story {slug: "alpha"})-[:HAS_EVENT]->(e) RETURN count(e) AS count'
    );
    expect(eventRecords[0].get("count")).toBe(0);
    const { records: relRecords } = await driver.executeQuery(
      'MATCH (:Story {slug: "alpha"})-[r:RELATED_STORY]->() RETURN count(r) AS count'
    );
    expect(relRecords[0].get("count")).toBe(0);

    // The story that pointed at alpha keeps its RELATED_STORY edge.
    const { records: incoming } = await driver.executeQuery(
      'MATCH (:Story {slug: "gamma"})-[:RELATED_STORY]->(:Story {slug: "alpha"}) RETURN count(*) AS count'
    );
    expect(incoming[0].get("count")).toBe(1);

    // Shared Article and Source nodes survive the delete.
    const { records: articles } = await driver.executeQuery(
      'MATCH (a:Article {url: "https://www.reuters.com/world/e01"})-[:PUBLISHED_BY]->(:Source) RETURN count(a) AS count'
    );
    expect(articles[0].get("count")).toBe(1);

    // The remaining stories are untouched, and alpha is forgotten by every read.
    expect(await store.getStory("alpha")).toBeNull();
    expect((await store.listStoryMetas()).map((m) => m.slug)).toEqual(["beta", "gamma"]);
    const beta = await store.getStory("beta");
    expect(beta?.events[0].sources[0].url).toBe("https://www.reuters.com/world/e01");
  });

  it("a deleted-then-resent story refills the same stub node", async () => {
    await wipe();
    const store = createNeo4jStore({ driver });
    await store.saveNewStory(makeStory("alpha"));
    await store.deleteStory("alpha");

    const rebuilt = makeStory("alpha", { title: "Rebuilt alpha", hook: undefined, queries: undefined });
    await store.saveNewStory(rebuilt);
    const { events, ...meta } = rebuilt;
    expect(await store.getStory("alpha")).toEqual({
      ...meta,
      events: [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    });
  });
});

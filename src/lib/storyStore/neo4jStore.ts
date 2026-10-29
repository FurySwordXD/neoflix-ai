import neo4j, { type Driver, type ManagedTransaction } from "neo4j-driver";
import { limitMotions } from "../mapMotion";
import type { GeneratedEvent, SourceRef, Story, StoryEvent } from "../types";
import { ensureSchema, sourceDomain } from "./neo4j";
import {
  concludedEndAt,
  generatedEventId,
  sortEvents,
  toListItem,
  toSavedEvent,
  toStoryMeta,
  withRememberedQuery,
} from "./shared";
import type { StoryMeta, StoryPatch, StoryStore } from "./types";

/**
 * Story store on the Neo4j graph shared with news-scraper.
 *
 *   (:Story {slug})-[:HAS_EVENT]->(:Event {key: "<slug>/<id>"})
 *   (:Event)-[:CITES {order, bias, corroborates, ...}]->(:Article {url})-[:PUBLISHED_BY]->(:Source {domain})
 *   (:Story)-[:RELATED_STORY {relation, title, order}]->(:Story)
 *
 * A related story that was never saved exists only as a `Story {slug}` stub
 * with no `createdAt`; every read skips stubs. CITES keeps the publisher,
 * title and date the source was cited with, because news-scraper rewrites
 * those Article fields when it scrapes the same URL.
 */

export interface Neo4jStoreOptions {
  driver: Driver;
  database?: string;
}

type Props = Record<string, unknown>;

const META_QUERY = `
MATCH (s:Story)
WHERE s.createdAt IS NOT NULL AND ($slug IS NULL OR s.slug = $slug)
OPTIONAL MATCH (s)-[r:RELATED_STORY]->(t:Story)
WITH s, r, t ORDER BY r.order
RETURN properties(s) AS story,
       collect(CASE WHEN r IS NULL THEN null ELSE {slug: t.slug, title: r.title, relation: r.relation} END) AS related
ORDER BY story.slug`;

const EVENTS_QUERY = `
MATCH (:Story {slug: $slug})-[:HAS_EVENT]->(e:Event)
OPTIONAL MATCH (e)-[c:CITES]->(a:Article)
WITH e, c, a ORDER BY c.order
RETURN properties(e) AS event,
       collect(CASE WHEN c IS NULL THEN null ELSE {cites: properties(c), url: a.url} END) AS sources`;

/** Takes the story's write lock and reports whether it is a saved story (not a stub). */
const LOCK_STORY = `
MATCH (s:Story {slug: $slug})
SET s.refreshedAt = s.refreshedAt
RETURN s.createdAt IS NOT NULL AS saved`;

const WRITE_EVENTS = `
MATCH (s:Story {slug: $slug})
UNWIND $events AS e
MERGE (ev:Event {key: e.props.key})
SET ev = e.props
MERGE (s)-[:HAS_EVENT]->(ev)
WITH ev, e
OPTIONAL MATCH (ev)-[old:CITES]->()
DELETE old
WITH DISTINCT ev, e
UNWIND e.sources AS src
MERGE (a:Article {url: src.url})
SET a.title = coalesce(a.title, src.title),
    a.publisher = coalesce(a.publisher, src.publisher),
    a.published = coalesce(a.published, src.publishedAt)
MERGE (d:Source {domain: src.domain})
MERGE (a)-[:PUBLISHED_BY]->(d)
CREATE (ev)-[:CITES {
  order: src.order, id: src.id, title: src.title, publisher: src.publisher,
  publishedAt: src.publishedAt, bias: src.bias, corroborates: src.corroborates
}]->(a)`;

const WRITE_RELATED = `
MATCH (s:Story {slug: $slug})
UNWIND $related AS r
MERGE (t:Story {slug: r.slug})
CREATE (s)-[:RELATED_STORY {relation: r.relation, title: r.title, order: r.order}]->(t)`;

/** Every property a save or refresh can set; nulling them blanks the Story node back into a stub. */
const BLANK_STORY_PROPS = {
  title: null,
  subtitle: null,
  description: null,
  status: null,
  startAt: null,
  endAt: null,
  hook: null,
  epilogue: null,
  queries: null,
  createdAt: null,
  refreshedAt: null,
};

export function createNeo4jStore({ driver, database }: Neo4jStoreOptions): StoryStore {
  async function run<T>(
    mode: "READ" | "WRITE",
    work: (tx: ManagedTransaction) => Promise<T>
  ): Promise<T> {
    await ensureSchema(driver, database);
    const session = driver.session({
      database,
      defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE,
    });
    try {
      return mode === "READ" ? await session.executeRead(work) : await session.executeWrite(work);
    } finally {
      await session.close();
    }
  }

  async function readMetas(tx: ManagedTransaction, slug: string | null): Promise<StoryMeta[]> {
    const { records } = await tx.run(META_QUERY, { slug });
    return records.map((r) => toMeta(r.get("story") as Props, r.get("related") as Props[]));
  }

  async function readStory(tx: ManagedTransaction, slug: string): Promise<Story | null> {
    const [meta] = await readMetas(tx, slug);
    if (!meta) return null;
    const { records } = await tx.run(EVENTS_QUERY, { slug });
    const events = records.map((r) => toEvent(r.get("event") as Props, r.get("sources") as Props[]));
    const { createdAt: _created, refreshedAt: _refreshed, ...story } = meta;
    // Stories saved under an older, busier prompt get the same motion budget.
    return { ...story, events: limitMotions(sortEvents(events)) };
  }

  async function lockStory(tx: ManagedTransaction, slug: string): Promise<boolean> {
    const { records } = await tx.run(LOCK_STORY, { slug });
    return records[0]?.get("saved") === true;
  }

  async function writeEvents(tx: ManagedTransaction, slug: string, events: StoryEvent[]) {
    if (events.length === 0) return;
    await tx.run(WRITE_EVENTS, { slug, events: events.map((e) => eventParams(slug, e)) });
  }

  async function saveNewStory(story: Story): Promise<Story> {
    const created = await run("WRITE", async (tx) => {
      const { records } = await tx.run(
        "MERGE (s:Story {slug: $slug}) SET s.refreshedAt = s.refreshedAt RETURN s.createdAt IS NOT NULL AS saved",
        { slug: story.slug }
      );
      if (records[0]?.get("saved") === true) return false;
      const now = new Date().toISOString();
      await tx.run("MATCH (s:Story {slug: $slug}) SET s += $props", {
        slug: story.slug,
        props: { ...storyProps(story), createdAt: now, refreshedAt: now },
      });
      await tx.run(WRITE_RELATED, { slug: story.slug, related: relatedParams(story) });
      await writeEvents(tx, story.slug, story.events);
      return true;
    });
    if (created) return story;
    const existing = await run("READ", (tx) => readStory(tx, story.slug));
    if (!existing) throw new Error(`Story "${story.slug}" could not be read back`);
    return existing;
  }

  async function appendStoryEvents(slug: string, events: StoryEvent[], patch?: StoryPatch): Promise<Story> {
    await run("WRITE", async (tx) => {
      if (!(await lockStory(tx, slug))) throw new Error(`Story "${slug}" not found`);
      const { records } = await tx.run(
        "MATCH (:Story {slug: $slug})-[:HAS_EVENT]->(e:Event) RETURN properties(e) AS event",
        { slug }
      );
      const existing = sortEvents(records.map((r) => toEvent(r.get("event") as Props, [])));
      await writeEvents(tx, slug, events);

      // The "now" beat marks the newest development. When newer events land
      // after it, the old one is no longer the story's present: demote it.
      const prevLast = existing[existing.length - 1];
      if (events.length > 0 && prevLast?.beat === "now") {
        await tx.run("MATCH (e:Event {key: $key}) SET e.beat = 'escalation'", {
          key: eventKey(slug, prevLast.id),
        });
      }

      await tx.run(
        `MATCH (s:Story {slug: $slug})
         SET s.refreshedAt = $now,
             s.status = coalesce($status, s.status),
             s.epilogue = coalesce($epilogue, s.epilogue),
             s.endAt = CASE WHEN $status = 'concluded' AND s.endAt IS NULL THEN $endAt ELSE s.endAt END`,
        {
          slug,
          now: new Date().toISOString(),
          status: patch?.status || null,
          epilogue: patch?.epilogue || null,
          endAt: concludedEndAt(existing, events),
        }
      );
    });
    const updated = await run("READ", (tx) => readStory(tx, slug));
    if (!updated) throw new Error(`Story "${slug}" not found`);
    return updated;
  }

  async function saveGeneratedEvent(slug: string, generated: GeneratedEvent): Promise<StoryEvent> {
    return run("WRITE", async (tx) => {
      if (!(await lockStory(tx, slug))) throw new Error(`Story "${slug}" not found`);
      const { records } = await tx.run(
        "MATCH (:Story {slug: $slug})-[:HAS_EVENT]->(e:Event) RETURN count(e) AS count",
        { slug }
      );
      const event = toSavedEvent(generatedEventId(Number(records[0]?.get("count") ?? 0)), generated);
      await writeEvents(tx, slug, [event]);
      return event;
    });
  }

  async function rememberQuery(slug: string, query: string): Promise<void> {
    await run("WRITE", async (tx) => {
      if (!(await lockStory(tx, slug))) return;
      const { records } = await tx.run("MATCH (s:Story {slug: $slug}) RETURN s.queries AS queries", { slug });
      const known = records[0]?.get("queries");
      const queries = withRememberedQuery(Array.isArray(known) ? known.map(String) : undefined, query);
      if (queries) await tx.run("MATCH (s:Story {slug: $slug}) SET s.queries = $queries", { slug, queries });
    });
  }

  /**
   * Removes a story's properties, events and outgoing related-story edges.
   * The Story node itself stays as a stub — other stories' RELATED_STORY
   * edges may point at it, and a later save re-merges onto it — and shared
   * Article/Source nodes are left for the other stories and news-scraper.
   */
  async function deleteStory(slug: string): Promise<void> {
    await run("WRITE", async (tx) => {
      await tx.run(
        `MATCH (s:Story {slug: $slug})
         OPTIONAL MATCH (s)-[rel:RELATED_STORY]->()
         DELETE rel
         WITH DISTINCT s
         OPTIONAL MATCH (s)-[:HAS_EVENT]->(e:Event)
         DETACH DELETE e
         WITH DISTINCT s
         SET s += $reset`,
        { slug, reset: BLANK_STORY_PROPS }
      );
    });
  }

  return {
    listStoryMetas: () => run("READ", (tx) => readMetas(tx, null)),
    listStories: async () => (await run("READ", (tx) => readMetas(tx, null))).map(toListItem),
    getStory: (slug) => run("READ", (tx) => readStory(tx, slug)),
    saveNewStory,
    appendStoryEvents,
    saveGeneratedEvent,
    rememberQuery,
    deleteStory,
  };
}

function eventKey(slug: string, id: string): string {
  return `${slug}/${id}`;
}

function storyProps(story: Story): Props {
  const meta = toStoryMeta(story);
  return {
    title: meta.title,
    subtitle: meta.subtitle,
    description: meta.description,
    status: meta.status,
    startAt: meta.startAt,
    endAt: meta.endAt ?? null,
    hook: meta.hook ?? null,
    epilogue: meta.epilogue ?? null,
    queries: meta.queries ?? null,
  };
}

function relatedParams(story: Story): Props[] {
  return (story.relatedStories ?? []).map((r, order) => ({ ...r, order }));
}

function eventParams(slug: string, event: StoryEvent): Props {
  return {
    props: {
      key: eventKey(slug, event.id),
      id: event.id,
      title: event.title,
      summary: event.summary,
      timestamp: event.timestamp,
      category: event.category,
      magnitude: event.magnitude ?? null,
      beat: event.beat ?? null,
      consequence: event.consequence ?? null,
      narration: event.narration ?? null,
      lat: event.location.lat,
      lng: event.location.lng,
      place: event.location.name,
      country: event.location.country,
      motion: event.motion ? JSON.stringify(event.motion) : null,
      images: event.images ? JSON.stringify(event.images) : null,
    },
    sources: event.sources.map((s, order) => ({
      order,
      id: s.id,
      url: s.url,
      title: s.title,
      publisher: s.publisher,
      publishedAt: s.publishedAt,
      domain: sourceDomain(s.url),
      bias: JSON.stringify(s.bias),
      corroborates: s.corroborates ?? null,
    })),
  };
}

/** Graph rows are shared with another app, so read them defensively. */
function str(props: Props, field: string): string {
  const value = props[field];
  if (typeof value !== "string") {
    throw new Error(`Graph record is missing "${field}" (got ${value === null ? "null" : typeof value})`);
  }
  return value;
}

function optional<T>(value: unknown, read: (v: unknown) => T): T | undefined {
  return value === null || value === undefined ? undefined : read(value);
}

function parseJson(field: string) {
  return (value: unknown) => {
    try {
      return JSON.parse(String(value));
    } catch {
      throw new Error(`Graph record has invalid JSON in "${field}"`);
    }
  };
}

function toMeta(props: Props, related: Props[]): StoryMeta {
  const status = str(props, "status");
  const meta: StoryMeta = {
    slug: str(props, "slug"),
    title: str(props, "title"),
    subtitle: str(props, "subtitle"),
    description: str(props, "description"),
    status: status === "concluded" ? "concluded" : "ongoing",
    startAt: str(props, "startAt"),
    relatedStories: related.map((r) => ({ slug: str(r, "slug"), title: str(r, "title"), relation: str(r, "relation") })),
  };
  const queries = optional(props.queries, (v) => (Array.isArray(v) ? v.map(String) : []));
  return {
    ...meta,
    ...(props.endAt ? { endAt: String(props.endAt) } : {}),
    ...(props.hook ? { hook: String(props.hook) } : {}),
    ...(props.epilogue ? { epilogue: String(props.epilogue) } : {}),
    ...(queries ? { queries } : {}),
    ...(props.createdAt ? { createdAt: String(props.createdAt) } : {}),
    ...(props.refreshedAt ? { refreshedAt: String(props.refreshedAt) } : {}),
  };
}

function toSource(row: Props): SourceRef {
  const cites = row.cites as Props;
  const corroborates = optional(cites.corroborates, (v) => (Array.isArray(v) ? v.map(String) : []));
  return {
    id: str(cites, "id"),
    publisher: str(cites, "publisher"),
    title: str(cites, "title"),
    url: str(row, "url"),
    publishedAt: str(cites, "publishedAt"),
    bias: parseJson("bias")(cites.bias),
    ...(corroborates ? { corroborates } : {}),
  };
}

function toEvent(props: Props, sources: Props[]): StoryEvent {
  const event: StoryEvent = {
    id: str(props, "id"),
    title: str(props, "title"),
    summary: str(props, "summary"),
    location: {
      name: str(props, "place"),
      country: str(props, "country"),
      lat: Number(props.lat),
      lng: Number(props.lng),
    },
    timestamp: str(props, "timestamp"),
    category: str(props, "category") as StoryEvent["category"],
    sources: sources.map(toSource),
  };
  const magnitude = optional(props.magnitude, Number);
  const motion = optional(props.motion, parseJson("motion"));
  const images = optional(props.images, parseJson("images"));
  return {
    ...event,
    ...(magnitude !== undefined ? { magnitude } : {}),
    ...(props.beat ? { beat: String(props.beat) as StoryEvent["beat"] } : {}),
    ...(props.consequence ? { consequence: String(props.consequence) } : {}),
    ...(props.narration ? { narration: String(props.narration) } : {}),
    ...(motion ? { motion } : {}),
    ...(images ? { images } : {}),
  };
}

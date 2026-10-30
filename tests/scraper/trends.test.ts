import { describe, expect, it } from "vitest";
import { decodeXmlEntities, elementText, fetchTrendRss, parseTraffic, parseTrendItem, trendsFeedUrl } from "@/lib/scraper/trends";

const NOW = "Thu, 29 Oct 2026 16:40:00 -0700";

function item(overrides: Record<string, string> = {}, headlines: Array<[string, string, string]> = []): string {
  const newsItems = headlines
    .map(
      ([title, url, source]) =>
        `<ht:news_item><ht:news_item_title>${title}</ht:news_item_title>` +
        `<ht:news_item_url>${url}</ht:news_item_url>` +
        `<ht:news_item_source>${source}</ht:news_item_source></ht:news_item>`
    )
    .join("");
  return (
    `<item><title>${overrides.title ?? "some topic"}</title>` +
    `<ht:approx_traffic>${overrides.traffic ?? "1,000+"}</ht:approx_traffic>` +
    `<pubDate>${overrides.pubDate ?? NOW}</pubDate>${newsItems}</item>`
  );
}

describe("parseTraffic", () => {
  it("reads the feed's traffic spellings", () => {
    expect(parseTraffic("200,000+")).toBe(200000);
    expect(parseTraffic("50K+")).toBe(50000);
    expect(parseTraffic("1M+")).toBe(1000000);
    expect(parseTraffic("1,000")).toBe(1000);
    expect(parseTraffic("10k+")).toBe(10000);
  });

  it("returns null for unparseable traffic", () => {
    expect(parseTraffic("")).toBeNull();
    expect(parseTraffic("n/a")).toBeNull();
  });
});

describe("elementText", () => {
  it("concatenates repeated children and decodes entities", () => {
    expect(elementText("<x><title>A &amp; B</title><title>C</title></x>", "title")).toBe("A & B C");
    expect(elementText("<x><title>A&#8217;s</title></x>", "title")).toBe("A\u2019s");
  });

  it("returns null when the element is absent", () => {
    expect(elementText("<x></x>", "title")).toBeNull();
  });
});

describe("decodeXmlEntities", () => {
  it("unescapes named and numeric references, ampersand last", () => {
    expect(decodeXmlEntities("&amp;amp;")).toBe("&amp;");
    expect(decodeXmlEntities("B&amp;B &lt;tag&gt; &quot;q&quot; &#65;&#x42;")).toBe("B&B <tag> \"q\" AB");
  });
});

describe("parseTrendItem", () => {
  it("reads name, traffic, time and headlines", () => {
    const parsed = parseTrendItem(
      item({}, [
        ["Headline one", "https://www.reuters.com/a", "Reuters"],
        ["Headline two", "https://apnews.com/b", "AP"],
        ["skipped: no url", "not a url", "X"],
        ["Headline three", "https://example.com/c", ""],
      ]),
      "US",
      5
    );
    expect(parsed).toMatchObject({
      key: "some topic",
      name: "some topic",
      traffic: 1000,
      trafficLabel: "1,000+",
      at: new Date(Date.parse(NOW)).toISOString(),
      geos: ["US"],
    });
    expect(parsed?.headlines).toEqual([
      { title: "Headline one", url: "https://www.reuters.com/a", source: "Reuters" },
      { title: "Headline two", url: "https://apnews.com/b", source: "AP" },
      // An empty source falls back to the URL's domain.
      { title: "Headline three", url: "https://example.com/c", source: "example.com" },
    ]);
  });

  it("caps the headlines at headlinesPerItem", () => {
    const parsed = parseTrendItem(
      item({}, [
        ["h1", "https://a.example/1", "A"],
        ["h2", "https://b.example/2", "B"],
        ["h3", "https://c.example/3", "C"],
      ]),
      "US",
      2
    );
    expect(parsed?.headlines.map((headline) => headline.title)).toEqual(["h1", "h2"]);
  });

  it("returns null without a title, and tolerates a missing traffic or pubDate", () => {
    expect(parseTrendItem("<item></item>", "US", 5)).toBeNull();
    const bare = parseTrendItem("<item><title>bare</title></item>", "GB", 5);
    expect(bare).toMatchObject({ key: "bare", traffic: null, trafficLabel: null, at: null, geos: ["GB"] });
  });
});

describe("fetchTrendRss", () => {
  const feeds: Record<string, string> = {
    US: [item({ title: "US quake", traffic: "100K+" }), item({ title: "shared topic", traffic: "2,000+" })].join(""),
    GB: [item({ title: "shared topic", traffic: "50,000+", pubDate: "Thu, 29 Oct 2026 15:00:00 -0700" }), item({ title: "GB vote", traffic: "10K+" })].join(""),
  };

  function feedFetcher(failGeos: string[] = []) {
    return async (url: string): Promise<string> => {
      const geo = new URL(url).searchParams.get("geo") ?? "";
      if (failGeos.includes(geo)) throw new Error(`HTTP ${geo === "US" ? 403 : 500}`);
      const xml = feeds[geo];
      if (xml === undefined) throw new Error(`unexpected feed ${geo}`);
      return xml;
    };
  }

  it("reads each feed, dedupes shared terms and keeps the higher traffic", async () => {
    const { items, failedGeos } = await fetchTrendRss({ geos: ["US", "GB"], fetchXml: feedFetcher() });
    expect(failedGeos).toEqual([]);
    // Highest traffic first across all feeds.
    expect(items.map((item) => [item.name, item.traffic])).toEqual([
      ["US quake", 100000],
      ["shared topic", 50000],
      ["GB vote", 10000],
    ]);
    const shared = items[1];
    expect(shared.geos).toEqual(["US", "GB"]);
    // The newest pubDate wins across feeds.
    expect(shared.at).toBe(new Date(Date.parse(NOW)).toISOString());
  });

  it("caps items per feed and still merges across geos", async () => {
    // One item per feed: "US quake" from the US feed and "shared topic"
    // (its higher-traffic GB row) from the GB feed survive the cap.
    const { items } = await fetchTrendRss({ geos: ["US", "GB"], fetchXml: feedFetcher(), limitPerGeo: 1 });
    expect(items.map((item) => [item.name, item.geos])).toEqual([
      ["US quake", ["US"]],
      ["shared topic", ["GB"]],
    ]);
  });

  it("logs and skips failed feeds, and reports them", async () => {
    const { items, failedGeos } = await fetchTrendRss({ geos: ["US", "GB"], fetchXml: feedFetcher(["GB"]) });
    expect(failedGeos).toEqual(["GB"]);
    expect(items.map((item) => item.name)).toEqual(["US quake", "shared topic"]);
    expect(items.find((item) => item.name === "US quake")?.geos).toEqual(["US"]);
  });

  it("throws for an unencodable geo in the feed URL", () => {
    expect(trendsFeedUrl("US")).toBe("https://trends.google.com/trending/rss?geo=US");
  });
});

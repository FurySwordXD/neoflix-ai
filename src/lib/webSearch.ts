/**
 * Server-side web search for story generation. Nebius Token Factory does not
 * host a web_search tool, so we execute one ourselves and feed the results
 * back to the model as a function tool.
 *
 * Provider: Tavily (requires TAVILY_API_KEY in .env).
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

const FETCH_TIMEOUT_MS = 12_000;

function clean(text: string, max = 300): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Tavily search API. Requires TAVILY_API_KEY. */
async function tavilySearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
  console.log("Tavily web search: ", query);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
  };
  return (data.results ?? [])
    .filter((r) => r.url && r.title)
    .map((r) => ({
      title: clean(r.title ?? "", 180),
      url: r.url ?? "",
      snippet: clean(r.content ?? "", 400),
      date: r.published_date,
    }));
}

/**
 * Run the search. Returns [] on failure — the model is told to answer
 * without search results and rely on documented knowledge instead.
 */
export async function webSearch(query: string, maxResults = 8): Promise<WebSearchResult[]> {
  try {
    return await tavilySearch(query, maxResults);
  } catch (err) {
    console.warn(
      "[webSearch] tavily failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/** Format results for the model's function_call_output payload. */
export function formatSearchOutput(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return "No search results available. Rely on your own documented knowledge and note the limitation.";
  }
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}${r.date ? ` (${r.date})` : ""}\n${r.url}\n${r.snippet}`
    )
    .join("\n\n");
}

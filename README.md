# 🌍 Neoflix — Netflix for News, Powered by Agentic AI

> **You don't scroll through the news anymore. You press play on it.**

**Live demo:** https://neoflixai.vercel.app/

Type any topic — *"the 2026 midterms"*, *"COVID-19"*, *"the Apollo 11 moon landing"* — and an agentic AI researches it, compiles a documentary-style timeline of real, sourced events, plays it out on an interactive 3D globe with a broadcast newsreader's voice, and even renders a downloadable 1080p video — all in your browser.

---

## 📺 About the Project

### The idea

News today is **feed-shaped**. Infinite scroll, reverse chronology, headlines that scream but explain nothing. You read the *latest* article about a war — and you have no idea how it started, who the players are, or why the latest event matters. We're caught up on the *what* and completely lost on the *so what*.

Netflix solved this for fiction: instead of listing every episode, it gives you a **series** — a narrative arc with a hook, a spark, a turning point, and a payoff. We asked: **why can't news work the same way?**

So we built **Neoflix**: the Netflix for news, powered by agentic AI. Every story is a **season** — a timeline of real events in the world. Every event is an **episode** — with a timestamp, a place, a photograph, a voice, and a citation trail. Every source is **rated** — so you can see the political leaning and factual track record of each outlet behind every claim, and weigh the reporting for yourself.

**News is real. The drama is real. The only thing AI does is organize it.**

### How it works

A topic becomes a story in three phases:

1. **Research (agentic).** The model — NVIDIA Nemotron on Nebius AI Studio — runs a tool-use loop: it must call the Tavily `web_search` tool *before writing anything*. It probes broadly, then pins down the latest developments, and then writes. So everything is grounded with proper sources and citations instead of hallucinations.

2. **Compile (narrative).** The model returns chronological events as JSON, shaped into a documentary arc — `setup → spark → escalation → turning point → climax → fallout`, or `now` for ongoing stories. Each event carries a **connection chain**: the model identifies the 2–3 real driving factors (a court ruling, a policy shift, a statistic) and weaves each one as its own mini-timeline *before* the moment it visibly shaped the main story — so every "why did that happen?" has an answer on the map.

3. **Ground (trust).** Every event is anchored: a real place with accurate coordinates, 2+ real sources with publication dates, an outlet bias classification (`political lean` + `factual rating`, MBFC-style), and photos harvested from the coverage. Every image URL is fetched, decoded, and byte-verified before it's ever offered to the model — a 404, an HTML page, or a 1×1 tracking pixel never reaches the story.

The result plays on an interactive **3D globe**: campaign-style map animations show troops flowing, sieges encircling, missiles launching, and diseases spreading — exactly the kind of motion the sources describe, and nothing more. A documentary voice-over (ElevenLabs TTS) narrates each beat. You can pause, scrub the timeline, and ask grounded questions about the story — the Q&A model may **only** answer from the event records, citing each claim like `[e01]`, `[e06]`.

### What inspired us

Three things collided:

- **The explainer gap.** The best news product of the last decade wasn't an app — it was YouTube video essays and things like Vox's "explained" series. People don't want *more* news; they want *context and closure* for the news they already scrolled past.
- **Agentic AI finally got good enough** to do genuine multi-step research — search, verify, cite — rather than one-shot hallucination. The tool-use loop, the strict JSON schema, the bias annotations: all of that is only possible now.
- **A question about trust.** Could an AI tell the news *more* honestly than a feed does? Not by writing its own opinions — but by being relentlessly fact-first, showing the full source list with bias labels, and refusing to invent anything, even a photo. Neoflix is our answer: summaries stay factual and unopinionated on purpose; drama comes from real stakes and real consequences.

### How we built it

The whole stack runs serverless-friendly on Next.js:

- **The story pipeline** (`src/lib/generateStory.ts`) is an NDJSON stream: the model streams tool calls and JSON events, and the UI shows live progress ("researching…", "compiling events…"). The server-side research layer (`webSearch.ts` + `graphResearch.ts`) is **graph-first**: when the Neo4j knowledge graph is enabled, we search the articles our own scraper has already collected — enough fresh hits and Tavily is skipped entirely — and new search results are written back into the graph, so the next search for the same story is cheaper and faster.
- **Two storage backends** behind one `StoryStore` interface: plain JSON files under `src/data/stories` for zero-setup, or **Neo4j** — the real knowledge graph: `(:Story)-[:HAS_EVENT]->(:Event)-[:CITES]->(:Article)-[:PUBLISHED_BY]->(:Source)`, plus `:ABOUT` edges to trending `(:Topic)` nodes and their `:TRENDED` geo traffic. Both stores pass the same contract test suite (yes, the Neo4j one runs against a real Neo4j via Testcontainers).
- **An autonomous trend sync worker** (`src/lib/trendSync/`). This is the "Netflix" part: a background loop watches what's trending, classifies topics with the model, and decides — topic by topic — whether to **generate** a new story, **refresh** an existing one, or just **link** it, all within per-cycle caps and distributed lease locks so two workers never fight over the same story. The dashboard then ranks what's live with a **content-based recommender**: your reader profile is a weighted vector over interests, and each story is scored by cosine similarity blended with a region match and a freshness prior:

$$\text{cosine}(\vec{u}, \vec{s}) = \frac{\vec{u} \cdot \vec{s}}{\|\vec{u}\| \, \|\vec{s}\|}$$

  Results are then spaced out with **Maximal Marginal Relevance** so one subject can't occupy every slot:

$$\text{MMR} = \lambda \cdot \text{score}(\vec{s}) - (1-\lambda) \cdot \max_{\vec{d} \in \text{picked}} \text{cosine}(\vec{s}, \vec{d})$$

- **The video renderer.** A full Remotion composition (`remotion/StoryVideo.tsx` + `EarthScene.tsx`) turns the story into an actual documentary: a three.js Earth with an atmospheric glow shader and a procedural starfield, a camera that flies between event locations, kinetic captions, and the voice-over tracks. The twist: we render **in the browser** with `@remotion/web-renderer` — press a button, and a 1080p mp4 is encoded locally in a few seconds, with a progress bar and a download. No server farm, no render queue, no per-minute render bill — the server only ships the manifest and the Firebase audio URLs.

### The challenges we faced

- **Hallucination is a plumbing problem, not a prompt problem.** Our first stories cited beautiful URLs that didn't exist. Prompts didn't fix it. What fixed it: **making the pipeline reject everything the model can't ground** — image URLs must come verbatim from search results, images must decode (we fetch and verify bytes before offering them), sources must be real articles or fall back to the event's Wikipedia page. Trust in a citation is a property of the fetch, not of the LLM.
- **"Search once" is a lie.** One search round-trip left dates and final outcomes uncertain; unbounded searching burned through tokens and latency. We landed on a **2-query budget** in the system prompt: one broad, one for recent developments — and the model must decide when it's grounded enough to write.
- **Motion restraint.** The first map animations animated *everything* — every speech got a marching arrow, and the globe became noise. The fix was a design contract in the prompt: only animate beats where something *physical* happened (a border crossing, a blockade, a storm making landfall), cap it at 2–4 events per story, never two neighbouring events of the same kind, and never invent a route.
- **Racing agents.** When the trend worker and a user request both target the same story, they must not double-generate. We built **lease locks** in the graph (a `story:<query>` lock for generation, a `refresh:<slug>` lock for refreshes, ~10 minutes, auto-released) so concurrent agents queue instead of colliding — and the contract test suite proves it.
- **Rendering video in the browser.** Getting a three.js Earth + Remotion + WebCodecs encoding to work inside a browser tab was its own project — the low-level `createRoot` API, custom `extend(THREE)` registration for R3F, deterministic frame-by-frame camera aiming, and hardware-acceleration probing with graceful fallback. Seeing the first mp4 come out of a browser tab was the single best moment of the hackathon.

### What we learned

- **Grounding is a system design.** Every layer — the search tool, the schema, the JSON validator, the image verifier — must *default to refusing* what it can't verify. "Fail closed" is the only reliable anti-hallucination strategy we found.
- **Graphs are great memory for agents.** Storing research as a Neo4j graph (Articles, Sources, Topics, traffic) means the agent's next research session is incremental, not cold — and the graph doubles as the analytics layer for the dashboard.
- **The model is a compiler, not an author.** Our best results came from treating the LLM as a strict translator of *verified facts* into a narrative format — with validators and caps everywhere — never as a free writer.
- **Tests catch the agents, not just the code.** Because every dependency is injected (`CycleDeps`), we could run the full sync cycle on fakes — 243 tests, including a real Neo4j in Testcontainers, gate every change.

---

## 🛠️ Built With

`next.js` · `react` · `typescript` · `three.js` · `react-globe.gl` · `react-three-fiber` · `remotion` · `tailwindcss` · `neo4j` · `nebius-ai-studio` · `nvidia-nemotron` · `tavily` · `elevenlabs` · `openai-sdk` · `testcontainers` · `vitest` · `web-renderer` · `webcodecs` · `vercel` · `agentic-ai` · `knowledge-graph` · `rag` · `recommender-systems` · `llm` · `news`

---

## 🚀 Getting Started

```bash
npm install
cp .env.example .env   # add NEBIUS_API_KEY, TAVILY_API_KEY, ELEVENLABS_API_KEY
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), type a topic, and press play.

### Optional: the full pipeline

```bash
# Store stories in Neo4j (the shared knowledge graph) instead of JSON files
STORY_STORE=neo4j NEO4J_URI=bolt://localhost:7687 ...

# Graph-first research + the autonomous trend-sync worker
npm run graph:import
npm run sync:trends
```

### Tests

```bash
npm test          # 243 tests, incl. Neo4j via Testcontainers
npm run test:cov
```

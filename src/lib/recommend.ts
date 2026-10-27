/**
 * Content-based ranker for the dashboard.
 *
 * A reader profile is a weighted vector over subjects (explicit picks, their
 * neighbors on a small relatedness graph, and topics reinforced by stories
 * they actually open). Each trending story is a vector too. Relevance is
 * cosine similarity, mixed with a region match, a trending prior, and a
 * freshness prior. Maximal marginal relevance then spaces the list out so
 * one subject cannot occupy every slot.
 */

export interface ReaderProfile {
  interests: string[];
  regions: string[];
  /** Topic weights learned when the reader opens a story. */
  affinity: Record<string, number>;
  /** Set once the reader leaves the personalization page. */
  onboarded: boolean;
}

export const EMPTY_PROFILE: ReaderProfile = {
  interests: [],
  regions: [],
  affinity: {},
  onboarded: false,
};

export interface InterestOption {
  id: string;
  label: string;
  blurb: string;
}

export interface RegionOption {
  id: string;
  label: string;
}

export interface TrendItem {
  id: string;
  title: string;
  blurb: string;
  /** Sent to the story resolver: open a saved match, or generate. */
  query: string;
  /** Present when this trend is already a story on disk. */
  slug?: string;
  /** First topic is the primary subject. */
  topics: string[];
  regions: string[];
  /** Editorial prominence, 0–1, independent of the reader. */
  heat: number;
  /** How current the story feels, 0–1. */
  freshness: number;
  ongoing: boolean;
}

export interface ScoredTrend {
  item: TrendItem;
  score: number;
  reasons: string[];
}

export const INTERESTS: InterestOption[] = [
  { id: "health", label: "Public health", blurb: "Outbreaks, medicine, and health systems" },
  { id: "climate", label: "Climate", blurb: "Warming, weather, and adaptation" },
  { id: "conflict", label: "Conflict", blurb: "Wars, security, and diplomacy" },
  { id: "economy", label: "Economy", blurb: "Markets, crises, and trade" },
  { id: "science", label: "Science", blurb: "Discovery, research, and space" },
  { id: "tech", label: "Technology", blurb: "Platforms, AI, and infrastructure" },
  { id: "energy", label: "Energy", blurb: "Power, fuel, and transition" },
  { id: "politics", label: "Politics", blurb: "Elections, states, and power" },
  { id: "rights", label: "Rights", blurb: "Movements and civil liberties" },
  { id: "environment", label: "Environment", blurb: "Ecosystems and pollution" },
];

export const REGIONS: RegionOption[] = [
  { id: "global", label: "Worldwide" },
  { id: "africa", label: "Africa" },
  { id: "americas", label: "Americas" },
  { id: "asia", label: "Asia-Pacific" },
  { id: "europe", label: "Europe" },
  { id: "mena", label: "Middle East" },
];

/** Soft links so a climate reader still sees energy and environment stories. */
const RELATED: Record<string, string[]> = {
  health: ["science"],
  climate: ["environment", "energy", "science"],
  conflict: ["politics", "rights"],
  economy: ["energy", "politics"],
  science: ["tech", "health"],
  tech: ["science", "economy"],
  energy: ["climate", "economy", "environment"],
  politics: ["conflict", "rights", "economy"],
  rights: ["politics", "conflict"],
  environment: ["climate", "energy"],
};

const INTEREST_IDS = new Set(INTERESTS.map((item) => item.id));
const REGION_IDS = new Set(REGIONS.map((item) => item.id));

export const TRENDS: TrendItem[] = [
  {
    id: "ukraine",
    title: "Russia's invasion of Ukraine",
    blurb: "From the 2022 full-scale invasion to the war's long front and the diplomacy around it.",
    query: "Russia's invasion of Ukraine",
    topics: ["conflict", "politics"],
    regions: ["europe"],
    heat: 0.94,
    freshness: 0.86,
    ongoing: true,
  },
  {
    id: "gaza",
    title: "The war in Gaza",
    blurb: "The war that began in October 2023, and the humanitarian and diplomatic record since.",
    query: "the war in Gaza",
    topics: ["conflict", "rights", "politics"],
    regions: ["mena"],
    heat: 0.92,
    freshness: 0.9,
    ongoing: true,
  },
  {
    id: "ai",
    title: "The generative AI boom",
    blurb: "How chatbots left the lab and reset the race among labs, companies, and governments.",
    query: "the generative AI boom",
    topics: ["tech", "science", "economy"],
    regions: ["americas", "global"],
    heat: 0.9,
    freshness: 0.92,
    ongoing: true,
  },
  {
    id: "climate",
    title: "Extreme weather and a warming climate",
    blurb: "Heat, floods, and fire, and the record that ties them to a warming planet.",
    query: "extreme weather and climate change",
    topics: ["climate", "environment"],
    regions: ["global"],
    heat: 0.88,
    freshness: 0.9,
    ongoing: true,
  },
  {
    id: "election",
    title: "The 2024 US presidential election",
    blurb: "The campaign, the vote, and the transfer of power in the United States.",
    query: "the 2024 US presidential election",
    topics: ["politics"],
    regions: ["americas"],
    heat: 0.8,
    freshness: 0.62,
    ongoing: false,
  },
  {
    id: "covid",
    title: "COVID-19 pandemic",
    blurb: "From the first reports in Wuhan to the end of the global health emergency.",
    query: "COVID-19 pandemic",
    slug: "covid-19-pandemic",
    topics: ["health", "science"],
    regions: ["global"],
    heat: 0.72,
    freshness: 0.34,
    ongoing: false,
  },
  {
    id: "energy-europe",
    title: "Europe's energy crisis",
    blurb: "Gas, prices, and how Europe rewired its power supply after 2022.",
    query: "Europe's energy crisis",
    topics: ["energy", "economy", "climate"],
    regions: ["europe"],
    heat: 0.7,
    freshness: 0.5,
    ongoing: false,
  },
  {
    id: "amazon",
    title: "Deforestation in the Amazon",
    blurb: "Forest loss in the Amazon basin, the policies that sped it up, and the efforts to slow it.",
    query: "deforestation in the Amazon",
    topics: ["environment", "climate"],
    regions: ["americas"],
    heat: 0.64,
    freshness: 0.58,
    ongoing: true,
  },
  {
    id: "paris",
    title: "The Paris Agreement",
    blurb: "The 2015 climate pact and the years of pledges, gaps, and summits that followed.",
    query: "the Paris Agreement",
    topics: ["climate", "politics"],
    regions: ["global"],
    heat: 0.6,
    freshness: 0.4,
    ongoing: true,
  },
  {
    id: "crisis-2008",
    title: "The 2008 financial crisis",
    blurb: "The housing bust, the bank failures, and the recession that followed.",
    query: "the 2008 financial crisis",
    topics: ["economy"],
    regions: ["americas", "global"],
    heat: 0.58,
    freshness: 0.18,
    ongoing: false,
  },
  {
    id: "supply",
    title: "The global supply-chain shock",
    blurb: "Ports, shortages, and inflation after the pandemic froze trade.",
    query: "the global supply chain crisis",
    topics: ["economy", "tech"],
    regions: ["global", "asia"],
    heat: 0.57,
    freshness: 0.36,
    ongoing: false,
  },
  {
    id: "chernobyl",
    title: "The Chernobyl disaster",
    blurb: "The 1986 reactor explosion and the long cleanup that followed.",
    query: "Chernobyl disaster",
    slug: "chernobyl-disaster",
    topics: ["energy", "environment", "science"],
    regions: ["europe"],
    heat: 0.5,
    freshness: 0.16,
    ongoing: false,
  },
  {
    id: "ebola",
    title: "The West Africa Ebola epidemic",
    blurb: "The 2014 outbreak, the response, and the communities it moved through.",
    query: "the 2014 West Africa Ebola epidemic",
    topics: ["health"],
    regions: ["africa"],
    heat: 0.5,
    freshness: 0.2,
    ongoing: false,
  },
  {
    id: "fukushima",
    title: "The Fukushima nuclear accident",
    blurb: "The 2011 earthquake, the meltdown, and the evacuation along Japan's coast.",
    query: "the Fukushima nuclear accident",
    topics: ["energy", "environment", "science"],
    regions: ["asia"],
    heat: 0.49,
    freshness: 0.18,
    ongoing: false,
  },
  {
    id: "arab-spring",
    title: "The Arab Spring",
    blurb: "The 2011 uprisings and the governments that fell or held on.",
    query: "the Arab Spring",
    topics: ["politics", "rights"],
    regions: ["mena", "africa"],
    heat: 0.52,
    freshness: 0.14,
    ongoing: false,
  },
  {
    id: "brexit",
    title: "Brexit",
    blurb: "The referendum, the departure from the European Union, and the settlement after.",
    query: "Brexit",
    topics: ["politics", "economy"],
    regions: ["europe"],
    heat: 0.48,
    freshness: 0.28,
    ongoing: false,
  },
  {
    id: "hong-kong",
    title: "The Hong Kong protests",
    blurb: "The 2019 demonstrations and the security law that followed.",
    query: "the 2019 Hong Kong protests",
    topics: ["rights", "politics"],
    regions: ["asia"],
    heat: 0.46,
    freshness: 0.24,
    ongoing: false,
  },
  {
    id: "berlin",
    title: "Fall of the Berlin Wall",
    blurb: "How the wall that split the city opened in November 1989.",
    query: "Fall of the Berlin Wall",
    slug: "fall-of-the-berlin-wall",
    topics: ["politics", "conflict", "rights"],
    regions: ["europe"],
    heat: 0.42,
    freshness: 0.1,
    ongoing: false,
  },
  {
    id: "tsunami",
    title: "The 2004 Indian Ocean tsunami",
    blurb: "The earthquake, the wave, and the coastlines it reached.",
    query: "the 2004 Indian Ocean tsunami",
    topics: ["environment"],
    regions: ["asia"],
    heat: 0.44,
    freshness: 0.1,
    ongoing: false,
  },
  {
    id: "apollo",
    title: "Apollo 11",
    blurb: "The flight that put astronauts on the Moon in July 1969.",
    query: "Apollo 11 Moon landing",
    topics: ["science", "tech"],
    regions: ["americas"],
    heat: 0.4,
    freshness: 0.08,
    ongoing: false,
  },
];

function labelOf(id: string): string {
  return INTERESTS.find((item) => item.id === id)?.label ?? REGIONS.find((item) => item.id === id)?.label ?? id;
}

function userInterestVector(profile: ReaderProfile): Map<string, number> {
  const weights = new Map<string, number>();
  for (const id of profile.interests) {
    if (!INTEREST_IDS.has(id)) continue;
    weights.set(id, 1);
  }
  for (const id of profile.interests) {
    for (const related of RELATED[id] ?? []) {
      if (profile.interests.includes(related)) continue;
      weights.set(related, Math.max(weights.get(related) ?? 0, 0.35));
    }
  }
  for (const [id, raw] of Object.entries(profile.affinity)) {
    if (!INTEREST_IDS.has(id) || typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const extra = Math.min(Math.max(raw, 0), 2.5) * 0.22;
    weights.set(id, Math.min(1.45, (weights.get(id) ?? 0) + extra));
  }
  return weights;
}

function itemInterestVector(topics: string[]): Map<string, number> {
  const weights = new Map<string, number>();
  topics.forEach((id, index) => {
    if (!INTEREST_IDS.has(id)) return;
    const weight = index === 0 ? 1 : 0.65;
    weights.set(id, Math.max(weights.get(id) ?? 0, weight));
    for (const related of RELATED[id] ?? []) {
      if (topics.includes(related)) continue;
      weights.set(related, Math.max(weights.get(related) ?? 0, weight * 0.28));
    }
  });
  return weights;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (const value of a.values()) a2 += value * value;
  for (const value of b.values()) b2 += value * value;
  if (a2 === 0 || b2 === 0) return 0;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other) dot += value * other;
  }
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

/** 1 when a chosen region is on the story, 0.45 when either side is worldwide. */
function regionAffinity(userRegions: string[], itemRegions: string[]): number {
  const chosen = userRegions.filter((id) => REGION_IDS.has(id));
  if (chosen.length === 0 || itemRegions.length === 0) return 0;
  const user = new Set(chosen);
  let best = 0;
  for (const region of itemRegions) {
    if (user.has(region)) best = Math.max(best, 1);
    else if (region === "global" || user.has("global")) best = Math.max(best, 0.45);
  }
  return best;
}

function topicOverlap(a: TrendItem, b: TrendItem): number {
  const left = new Set(a.topics);
  const right = new Set(b.topics);
  let shared = 0;
  for (const topic of left) if (right.has(topic)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

function buildReasons(
  item: TrendItem,
  profile: ReaderProfile,
  interestSim: number,
  regionScore: number
): string[] {
  const reasons: string[] = [];
  const explicit = item.topics.filter((topic) => profile.interests.includes(topic));
  if (explicit.length > 0) {
    const names = explicit.slice(0, 2).map(labelOf);
    reasons.push(
      names.length === 1 ? `Because you follow ${names[0]}` : `Because you follow ${names[0]} and ${names[1]}`
    );
  } else if (profile.interests.length > 0 && interestSim >= 0.28) {
    reasons.push("Close to your subjects");
  }

  const regionHit = item.regions.find((region) => profile.regions.includes(region));
  if (regionHit) reasons.push(labelOf(regionHit));
  else if (regionScore >= 0.45 && profile.regions.length > 0) reasons.push("Worldwide");

  if (item.heat >= 0.85) reasons.push("Trending widely");
  else if (reasons.length === 0) {
    reasons.push(item.heat >= 0.55 ? "Widely followed" : "Worth mapping");
  }

  const seen = new Set<string>();
  return reasons.filter((reason) => (seen.has(reason) ? false : (seen.add(reason), true))).slice(0, 2);
}

function blendScore(
  profile: ReaderProfile,
  interestSim: number,
  regionScore: number,
  item: TrendItem
): number {
  const personalized =
    profile.interests.length > 0 ||
    Object.values(profile.affinity).some((value) => value > 0);
  const hasRegions = profile.regions.length > 0;

  if (!personalized && !hasRegions) return 0.72 * item.heat + 0.28 * item.freshness;
  if (!personalized) return 0.5 * regionScore + 0.32 * item.heat + 0.18 * item.freshness;
  if (!hasRegions) return 0.66 * interestSim + 0.2 * item.heat + 0.14 * item.freshness;
  return 0.56 * interestSim + 0.18 * regionScore + 0.16 * item.heat + 0.1 * item.freshness;
}

/**
 * Rank trends for this reader, then diversify with maximal marginal relevance
 * so the list is not nine variations of the same subject.
 */
export function recommend(
  items: TrendItem[],
  profile: ReaderProfile,
  limit = 9
): ScoredTrend[] {
  const userVector = userInterestVector(profile);
  const scored = items.map((item) => {
    const interestSim = cosine(userVector, itemInterestVector(item.topics));
    const regionScore = regionAffinity(profile.regions, item.regions);
    return {
      item,
      score: blendScore(profile, interestSim, regionScore, item),
      reasons: buildReasons(item, profile, interestSim, regionScore),
    };
  });

  const personalized =
    profile.interests.length > 0 ||
    profile.regions.length > 0 ||
    Object.values(profile.affinity).some((value) => value > 0);
  const lambda = personalized ? 0.62 : 0.78;
  const pool = [...scored].sort((a, b) => b.score - a.score);
  const picked: ScoredTrend[] = [];

  while (picked.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const redundancy = picked.reduce(
        (max, chosen) => Math.max(max, topicOverlap(pool[i].item, chosen.item)),
        0
      );
      const value = lambda * pool[i].score - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    const [next] = pool.splice(bestIndex, 1);
    picked.push(next);
  }

  return picked;
}

export function topicsForSlug(slug: string): string[] {
  return TRENDS.find((item) => item.slug === slug)?.topics ?? [];
}

export function isInterestId(id: string): boolean {
  return INTEREST_IDS.has(id);
}

export function isRegionId(id: string): boolean {
  return REGION_IDS.has(id);
}

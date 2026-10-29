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
  else if (reasons.length === 0 && item.heat >= 0.55) reasons.push("Widely followed");

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

export function isInterestId(id: string): boolean {
  return INTEREST_IDS.has(id);
}

export function isRegionId(id: string): boolean {
  return REGION_IDS.has(id);
}

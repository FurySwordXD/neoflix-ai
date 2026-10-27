"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  EMPTY_PROFILE,
  isInterestId,
  isRegionId,
  type ReaderProfile,
} from "./recommend";

const PROFILE_KEY = "worldnews.profile.v1";
const PROFILE_EVENT = "worldnews-profile";

function empty(): ReaderProfile {
  return { interests: [], regions: [], affinity: {}, onboarded: false };
}

export function parseProfile(raw: string | null): ReaderProfile {
  if (!raw) return empty();
  try {
    const data = JSON.parse(raw) as Partial<ReaderProfile>;
    const interests = Array.isArray(data.interests)
      ? data.interests.filter((id): id is string => typeof id === "string" && isInterestId(id))
      : [];
    const regions = Array.isArray(data.regions)
      ? data.regions.filter((id): id is string => typeof id === "string" && isRegionId(id))
      : [];
    const affinity: Record<string, number> = {};
    if (data.affinity && typeof data.affinity === "object") {
      for (const [id, value] of Object.entries(data.affinity)) {
        if (isInterestId(id) && typeof value === "number" && Number.isFinite(value) && value > 0) {
          affinity[id] = Math.min(value, 2.5);
        }
      }
    }
    return { interests, regions, affinity, onboarded: data.onboarded === true };
  } catch {
    return empty();
  }
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener(PROFILE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(PROFILE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function getSnapshot() {
  return localStorage.getItem(PROFILE_KEY) ?? "";
}

function getServerSnapshot() {
  return "";
}

function writeProfile(profile: ReaderProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  window.dispatchEvent(new Event(PROFILE_EVENT));
}

/** The reader's interests, regions, and learned topic weights. Browser-only. */
export function useReaderProfile(): [
  ReaderProfile,
  (next: ReaderProfile | ((current: ReaderProfile) => ReaderProfile)) => void,
] {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const profile = useMemo(() => (raw ? parseProfile(raw) : EMPTY_PROFILE), [raw]);
  const update = useCallback(
    (next: ReaderProfile | ((current: ReaderProfile) => ReaderProfile)) => {
      const current = parseProfile(localStorage.getItem(PROFILE_KEY));
      writeProfile(typeof next === "function" ? next(current) : next);
    },
    []
  );
  return [profile, update];
}

export function withInterest(profile: ReaderProfile, id: string): ReaderProfile {
  if (!isInterestId(id)) return profile;
  const interests = profile.interests.includes(id)
    ? profile.interests.filter((item) => item !== id)
    : [...profile.interests, id];
  return { ...profile, interests };
}

export function withRegion(profile: ReaderProfile, id: string): ReaderProfile {
  if (!isRegionId(id)) return profile;
  const regions = profile.regions.includes(id)
    ? profile.regions.filter((item) => item !== id)
    : [...profile.regions, id];
  return { ...profile, regions };
}

/** Reinforce the subjects of a story the reader chose to open. */
export function withOpen(profile: ReaderProfile, topics: string[]): ReaderProfile {
  const known = topics.filter(isInterestId);
  if (known.length === 0) return profile;
  const affinity = { ...profile.affinity };
  for (const topic of known) {
    affinity[topic] = Math.min(2.5, (affinity[topic] ?? 0) + 0.4);
  }
  return { ...profile, affinity };
}

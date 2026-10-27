"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { findExistingStory } from "@/lib/storyMatch";
import type { StoryMeta } from "@/lib/stories";
import type { Story } from "@/lib/types";
import {
  INTERESTS,
  REGIONS,
  TRENDS,
  recommend,
  topicsForSlug,
  type TrendItem,
} from "@/lib/recommend";
import { useReaderProfile, withOpen } from "@/lib/profile";
import StoryQueryForm from "./StoryQueryForm";

interface DashboardProps {
  metas: StoryMeta[];
}

interface Draft {
  interests: string[];
  regions: string[];
}

function savedSlug(item: TrendItem, metas: StoryMeta[]): string | null {
  if (item.slug && metas.some((meta) => meta.slug === item.slug)) return item.slug;
  return findExistingStory(item.query, metas)?.slug ?? null;
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

export default function Dashboard({ metas }: DashboardProps) {
  const router = useRouter();
  const [profile, update] = useReaderProfile();
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReady(true);
  }, []);

  const showPicker = ready && (!profile.onboarded || editing);
  const ranked = useMemo(() => recommend(TRENDS, profile, 9), [profile]);

  useEffect(() => {
    if (showPicker && !draft) {
      setDraft({ interests: [...profile.interests], regions: [...profile.regions] });
    }
  }, [showPicker, draft, profile.interests, profile.regions]);

  function go(slug: string, topics: string[]) {
    update((current) => withOpen(current, topics));
    router.push(`/?story=${encodeURIComponent(slug)}`);
  }

  function finishPicker() {
    const picks = draft ?? { interests: profile.interests, regions: profile.regions };
    update((current) => ({
      ...current,
      interests: picks.interests,
      regions: picks.regions,
      onboarded: true,
    }));
    setEditing(false);
    setDraft(null);
  }

  function openPicker() {
    setDraft({ interests: [...profile.interests], regions: [...profile.regions] });
    setEditing(true);
  }

  async function openTrend(item: TrendItem) {
    if (mapping) return;
    const existing = savedSlug(item, metas);
    if (existing) {
      go(existing, item.topics);
      return;
    }
    setMapping(item.query);
    setError(null);
    try {
      const res = await fetch("/api/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: item.query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not map that story");
      const story = data.story as Story;
      go(story.slug, item.topics.length > 0 ? item.topics : topicsForSlug(story.slug));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not map that story");
      setMapping(null);
    }
  }

  const interestLabels = INTERESTS.filter((item) => profile.interests.includes(item.id)).map(
    (item) => item.label
  );
  const regionLabels = REGIONS.filter((item) => profile.regions.includes(item.id)).map(
    (item) => item.label
  );
  const tuned = interestLabels.length > 0 || regionLabels.length > 0;

  if (!ready) {
    return <div className="h-screen bg-[#050810]" />;
  }

  if (showPicker) {
    const picks = draft ?? { interests: profile.interests, regions: profile.regions };
    return (
      <div className="scroll-slim flex h-screen flex-col overflow-y-auto bg-[#050810]">
        <header className="border-b border-slate-800 bg-slate-950/80 px-5 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="text-lg">🌍</span>
            <span className="text-sm font-bold uppercase tracking-[0.25em] text-slate-200">
              WorldNews
            </span>
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-10">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            What should we map for you?
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
            Choose the subjects and places you care about. This stays in this browser, and you can
            change it later.
          </p>

          <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Subjects
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {INTERESTS.map((interest) => {
              const pressed = picks.interests.includes(interest.id);
              return (
                <button
                  key={interest.id}
                  type="button"
                  aria-pressed={pressed}
                  title={interest.blurb}
                  onClick={() =>
                    setDraft({
                      interests: toggle(picks.interests, interest.id),
                      regions: picks.regions,
                    })
                  }
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                    pressed
                      ? "bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/60"
                      : "bg-slate-900 text-slate-300 ring-1 ring-slate-700 hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  {interest.label}
                </button>
              );
            })}
          </div>

          <h2 className="mt-6 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Regions
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {REGIONS.map((region) => {
              const pressed = picks.regions.includes(region.id);
              return (
                <button
                  key={region.id}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() =>
                    setDraft({
                      interests: picks.interests,
                      regions: toggle(picks.regions, region.id),
                    })
                  }
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                    pressed
                      ? "bg-violet-500/20 text-violet-100 ring-1 ring-violet-400/60"
                      : "bg-slate-900 text-slate-300 ring-1 ring-slate-700 hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  {region.label}
                </button>
              );
            })}
          </div>

          <div className="mt-8 flex items-center gap-4">
            <button
              type="button"
              onClick={finishPicker}
              className="rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500"
            >
              {editing ? "Save interests" : "Continue"}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(null);
                }}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                Cancel
              </button>
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="scroll-slim h-screen overflow-y-auto bg-[#050810]">
      <header className="border-b border-slate-800 bg-slate-950/80 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">🌍</span>
            <span className="text-sm font-bold uppercase tracking-[0.25em] text-slate-200">
              WorldNews
            </span>
          </div>
          <button
            type="button"
            onClick={openPicker}
            className="rounded-md px-2 py-1 text-xs text-slate-400 ring-1 ring-slate-800 hover:bg-slate-900 hover:text-slate-200"
          >
            Update interests
          </button>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-8 pb-16">
        <StoryQueryForm
          variant="hero"
          onBusy={(busy, query) => setMapping(busy ? query : null)}
          onStory={(story) => go(story.slug, topicsForSlug(story.slug))}
        />

        <section>
          <h2 className="text-sm font-semibold text-white">
            {tuned ? "Trending for you" : "Trending worldwide"}
          </h2>
          {tuned && (
            <p className="mt-1 text-xs text-slate-500">
              {[...interestLabels, ...regionLabels].join(", ")}
            </p>
          )}

          {error && (
            <p className="mt-4 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ranked.map(({ item, reasons }) => {
              const readyCard = savedSlug(item, metas);
              const shown = readyCard ? ["Ready on your map", ...reasons].slice(0, 2) : reasons;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={mapping !== null}
                  onClick={() => openTrend(item)}
                  className="fade-up flex h-full flex-col rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-left transition hover:border-sky-700/70 hover:bg-slate-900/80 disabled:opacity-60"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        item.ongoing
                          ? "bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
                          : "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30"
                      }`}
                    >
                      {item.ongoing ? "ongoing" : "concluded"}
                    </span>
                  </div>
                  <p className="mt-2 flex-1 text-xs leading-relaxed text-slate-400">{item.blurb}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {shown.map((reason) => (
                      <span
                        key={reason}
                        className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] text-slate-400 ring-1 ring-slate-800"
                      >
                        {reason}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 text-[11px] font-semibold text-sky-300">
                    {readyCard ? "Open" : "Map this story"}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </main>

      {mapping && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#050810]/80 backdrop-blur-sm">
          <div className="max-w-sm px-6 text-center">
            <p className="text-[11px] uppercase tracking-[0.28em] text-sky-400">Mapping the story</p>
            <p className="mt-3 text-sm font-medium text-white">{mapping}</p>
            <div className="shimmer mx-auto mt-5 h-1.5 w-40 rounded-full" />
          </div>
        </div>
      )}
    </div>
  );
}

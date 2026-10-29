"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { findExistingStory } from "@/lib/storyMatch";
import type { StoryMeta } from "@/lib/stories";
import {
  INTERESTS,
  REGIONS,
  recommend,
  type TrendItem,
} from "@/lib/recommend";
import { useReaderProfile, withOpen } from "@/lib/profile";
import StoryQueryForm from "./StoryQueryForm";
import LandingHero from "./LandingHero";
import GlobeCanvas, { type GlobeTargets } from "./GlobeCanvas";

interface DashboardProps {
  metas: StoryMeta[];
  /** Topics from the db: trending graph topics plus the saved-story shelf. */
  trends?: TrendItem[];
  onGenerate: (query: string, topics?: string[]) => void;
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

export default function Dashboard({ metas, trends, onGenerate }: DashboardProps) {
  const router = useRouter();
  const [profile, update] = useReaderProfile();
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState(0);
  const [landingDraft, setLandingDraft] = useState<Draft>({ interests: [], regions: [] });
  /** The planet idles behind the dashboard, blurred and dimmed. */
  const dashTargets = useRef<GlobeTargets>({ x: 0, y: 0.45, dim: 0.45 });

  useEffect(() => {
    setReady(true);
  }, []);

  /** First-run and "Update interests" both show the landing room. */
  const showLanding = ready && (!profile.onboarded || editing);
  const ranked = useMemo(
    () => recommend(trends ?? [], profile, 9),
    [trends, profile]
  );

  function go(slug: string, topics: string[]) {
    update((current) => withOpen(current, topics));
    router.push(`/?story=${encodeURIComponent(slug)}`);
  }

  function openPicker() {
    // Reopen the original onboarding room with the current picks staged.
    setLandingDraft({ interests: [...profile.interests], regions: [...profile.regions] });
    setStep(1);
    setEditing(true);
  }

  function openTrend(item: TrendItem) {
    const existing = savedSlug(item, metas);
    if (existing) {
      go(existing, item.topics);
      return;
    }
    onGenerate(item.query, item.topics);
  }

  const interestLabels = INTERESTS.filter((item) => profile.interests.includes(item.id)).map(
    (item) => item.label
  );
  const regionLabels = REGIONS.filter((item) => profile.regions.includes(item.id)).map(
    (item) => item.label
  );
  const tuned = interestLabels.length > 0 || regionLabels.length > 0;

  if (!ready) {
    return <div className="h-dvh" />;
  }

  if (showLanding) {
    return (
      <LandingHero
        step={step}
        interests={landingDraft.interests}
        regions={landingDraft.regions}
        onToggleInterest={(id) =>
          setLandingDraft((d) => ({ ...d, interests: toggle(d.interests, id) }))
        }
        onToggleRegion={(id) => setLandingDraft((d) => ({ ...d, regions: toggle(d.regions, id) }))}
        onAdvance={() => setStep(Math.min(1, step + 1))}
        onBack={() => setStep(Math.max(0, step - 1))}
        onSkip={() => setStep(1)}
        onFinish={() => {
          update((current) => ({
            ...current,
            interests: landingDraft.interests,
            regions: landingDraft.regions,
            onboarded: true,
          }));
          setStep(0);
          setEditing(false);
        }}
        onCancel={
          editing
            ? () => {
                setEditing(false);
                setStep(0);
              }
            : undefined
        }
      />
    );
  }

  return (
    <>
      {/* The planet stays in the room, softened behind the reading surface. */}
      <div aria-hidden="true" className="fixed inset-0 z-0 overflow-hidden">
        <div className="h-full w-full scale-110" style={{ filter: "blur(8px)" }}>
          <GlobeCanvas targets={dashTargets} />
        </div>
        <div className="absolute inset-0 bg-slate-950/40" />
      </div>

      <div className="scroll-slim relative z-10 h-dvh overflow-y-auto">
      <div className="glass mx-auto mt-3 flex w-[calc(100%-1.5rem)] max-w-6xl items-center justify-between gap-3 rounded-2xl px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">🌍</span>
          <span className="text-sm font-bold uppercase tracking-[0.25em] text-slate-200">
            Neoflix
          </span>
        </div>
        <button
          type="button"
          onClick={openPicker}
          className="glass-well rounded-lg px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          Update interests
        </button>
      </div>

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-8 pb-16">
        <StoryQueryForm variant="hero" onSearch={(query) => onGenerate(query)} />

        <section>
          <h2 className="text-sm font-semibold text-white">
            {tuned ? "Trending for you" : "Trending worldwide"}
          </h2>
          {tuned && (
            <p className="mt-1 text-xs text-slate-500">
              {[...interestLabels, ...regionLabels].join(", ")}
            </p>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ranked.length === 0 && (
              <p className="glass rounded-2xl p-4 text-xs leading-relaxed text-slate-400">
                Nothing is trending on the map yet — the sync worker picks up
                story-worthy topics as they trend. Search for any topic above
                and it becomes a story.
              </p>
            )}
            {ranked.map(({ item, reasons }) => {
              const readyCard = savedSlug(item, metas);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openTrend(item)}
                  className="glass fade-up flex h-full flex-col rounded-2xl p-4 text-left transition hover:border-sky-400/40 disabled:opacity-60"
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
                    {reasons.map((reason) => (
                      <span
                        key={reason}
                        className="glass-well rounded-full px-2 py-0.5 text-[10px] text-slate-400"
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
      </div>
    </>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { INTERESTS, REGIONS } from "@/lib/recommend";
import GlobeCanvas, { type GlobeTargets } from "./GlobeCanvas";

interface LandingHeroProps {
  step: number;
  interests: string[];
  regions: string[];
  onToggleInterest: (id: string) => void;
  onToggleRegion: (id: string) => void;
  onAdvance: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
  /** When provided (editing an existing profile), offers an exit from the flow. */
  onCancel?: () => void;
}

/**
 * The first-run room: a landing page and the interests picker staged
 * around one three.js Earth-at-night, which travels and dims as the
 * story moves from the idea to the reader's own interests.
 */
export default function LandingHero({
  step,
  interests,
  regions,
  onToggleInterest,
  onToggleRegion,
  onAdvance,
  onBack,
  onSkip,
  onFinish,
  onCancel,
}: LandingHeroProps) {
  const targets = useRef<GlobeTargets>({ x: 0, y: -0.1, dim: 0 });

  // Each chapter stages the planet differently.
  useEffect(() => {
    if (step === 0) targets.current = { x: 0, y: -0.1, dim: 0 };
    else targets.current = { x: 0, y: 0.75, dim: 0.62 };
  }, [step]);

  const chapterLabel = ["The idea", "Your news"][step] ?? "The idea";

  return (
    <div className="fixed inset-0 z-10 overflow-hidden">
      <GlobeCanvas targets={targets} />

      <div
        role="group"
        aria-label="Welcome to Neoflix"
        className="scroll-slim relative z-10 flex h-full flex-col overflow-y-auto"
      >
        <header className="flex items-center justify-between px-5 pt-6 sm:px-8">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-slate-300">
            Neoflix
          </p>
          <nav className="flex items-center gap-4" aria-label="Chapters">
            <span className="text-[13px] text-slate-500">{chapterLabel}</span>
            {step > 0 && (
              <button
                type="button"
                onClick={onBack}
                className="text-[13px] font-medium text-slate-400 transition hover:text-slate-200"
              >
                Back
              </button>
            )}
            {step === 0 && (
              <button
                type="button"
                onClick={onSkip}
                className="text-[13px] font-medium text-slate-400 transition hover:text-slate-200"
              >
                Skip to your news
              </button>
            )}
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="text-[13px] font-medium text-slate-400 transition hover:text-slate-200"
              >
                Cancel
              </button>
            )}
          </nav>
        </header>

        {/* Chapter 1 — the landing. */}
        {step === 0 && (
          <main className="fade-up flex flex-1 flex-col justify-end px-5 pb-12 sm:px-8">
            <div className="mx-auto w-full max-w-6xl">
              <h1 className="max-w-5xl text-balance text-[clamp(2.35rem,7vw,5.5rem)] font-light leading-[0.95] tracking-tight text-white">
                The world&rsquo;s news, told like a{" "}
                <em className="font-normal italic">film</em>.
              </h1>
              <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-slate-300">
                Type any topic — a war, an election, a discovery. An AI agent
                researches real reporting and plays the story back as a narrated
                timeline on a living globe, with every claim cited.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={onAdvance}
                  className="rounded-xl bg-sky-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400"
                >
                  Get started
                </button>
              </div>
              <p className="mt-8 text-[13px] text-slate-500">
                Drag the planet. The lights are real cities, photographed by NASA.
              </p>
            </div>
          </main>
        )}

        {/* Chapter 2 — interests. */}
        {step === 1 && (
          <main className="fade-up flex flex-1 flex-col justify-center px-5 py-10 sm:px-8">
            <div className="mx-auto w-full max-w-6xl">
              <h2 className="max-w-3xl text-balance text-[clamp(1.75rem,4vw,3rem)] font-light leading-[1.02] tracking-tight text-white">
                What should we watch?
              </h2>
              <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-slate-300">
                Pick a few subjects and places. This stays in your browser, and
                the front page reshapes around what you care about.
              </p>

              <div className="mt-10 max-w-3xl space-y-8">
                <div>
                  <h3 className="text-[13px] font-medium text-slate-400">Subjects</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {INTERESTS.map((interest) => {
                      const pressed = interests.includes(interest.id);
                      return (
                        <button
                          key={interest.id}
                          type="button"
                          aria-pressed={pressed}
                          title={interest.blurb}
                          onClick={() => onToggleInterest(interest.id)}
                          className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition ${
                            pressed
                              ? "bg-sky-500/25 text-sky-100 ring-1 ring-sky-400/60"
                              : "border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          {interest.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <h3 className="text-[13px] font-medium text-slate-400">Regions</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {REGIONS.map((region) => {
                      const pressed = regions.includes(region.id);
                      return (
                        <button
                          key={region.id}
                          type="button"
                          aria-pressed={pressed}
                          onClick={() => onToggleRegion(region.id)}
                          className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition ${
                            pressed
                              ? "bg-sky-400/25 text-sky-100 ring-1 ring-sky-300/60"
                              : "border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          {region.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={onFinish}
                className="mt-10 rounded-xl bg-sky-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-400"
              >
                Start watching
              </button>
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

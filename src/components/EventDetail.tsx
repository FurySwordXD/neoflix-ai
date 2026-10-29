"use client";

import { useState } from "react";
import type {
  SourceRef,
  Story,
  StoryEvent,
} from "@/lib/types";
import { motionCaption } from "@/lib/mapMotion";
import BiasBadge from "./BiasBadge";
import EventImageFigure from "./EventImageFigure";
import {
  BEAT_LABELS,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  formatDate,
  formatMagnitude,
} from "@/lib/ui";

interface Citation {
  eventId: string;
  title: string;
  timestamp: string;
  sources: Array<Pick<SourceRef, "id" | "publisher" | "title" | "url" | "bias">>;
}

/** Light same-title check for the card label; full matching lives in AppShell. */
function isSaved(slug: string, title: string, stories: Array<Pick<Story, "slug" | "title">>): boolean {
  if (stories.some((item) => item.slug === slug)) return true;
  const normalize = (value: string) =>
    value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = normalize(title);
  if (!wanted) return false;
  return stories.some((item) => normalize(item.title) === wanted);
}

interface EventDetailProps {
  story: Story;
  event: StoryEvent;
  /** Saved stories, so a related-story card can say whether it opens or maps. */
  stories: Array<Pick<Story, "slug" | "title" | "status">>;
  /** Open a related story: the saved one, or a fresh compile if it is not saved. */
  onOpenStory?: (slug: string, title: string) => void;
  onClose: () => void;
}

export default function EventDetail({ story, event, stories, onOpenStory, onClose }: EventDetailProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    if (!q.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: story.slug, question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setAnswer(data.answer);
      setCitations(data.citations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const catColor = CATEGORY_COLORS[event.category];

  return (
    <aside className="glass-solid scroll-slim fade-up flex h-full w-full flex-col overflow-y-auto rounded-2xl">
      {/* Header */}
      <div className="glass-solid sticky top-0 z-10 rounded-t-2xl px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {event.beat && (
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {BEAT_LABELS[event.beat]}
                </span>
              )}
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  color: catColor,
                  backgroundColor: `${catColor}1a`,
                  border: `1px solid ${catColor}55`,
                }}
              >
                {CATEGORY_LABELS[event.category]}
              </span>
              {event.magnitude && (
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                  scale {formatMagnitude(event.magnitude)}
                </span>
              )}
            </div>
            <h2 className="mt-2 text-lg font-semibold leading-snug text-white">
              {event.title}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              {formatDate(event.timestamp)} · {event.location.name},{" "}
              {event.location.country}
            </p>
            {event.motion && (
              <p className="mt-1 text-[11px] text-sky-300">{motionCaption(event.motion)}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close this event"
            className="glass-well rounded-lg px-2.5 py-1.5 text-xs text-slate-300 transition hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-6 px-5 py-5">
        {/* Narration — the documentary voice; summary below stays the plain record */}
        {event.narration && (
          <p className="font-serif text-[15px] italic leading-relaxed text-slate-100">
            {event.narration}
          </p>
        )}
        {/* Summary — deliberately unopinionated */}
        <p className="text-[13px] leading-relaxed text-slate-300">
          {event.summary}
        </p>
        {event.consequence && (
          <p className="-mt-3 border-l-2 border-sky-500/40 pl-3 text-[12px] italic leading-relaxed text-slate-400">
            {event.consequence}
          </p>
        )}

        {/* Photographs harvested from the coverage this event cites */}
        {event.images && event.images.length > 0 && (
          <section className="-mt-2 space-y-3">
            {event.images.map((image) => (
              <EventImageFigure key={image.url} image={image} />
            ))}
          </section>
        )}

        {/* Sources with bias profiles */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Sources ({event.sources.length})
          </h3>
          <ul className="space-y-3">
            {event.sources.map((source) => (
              <li key={source.id} className="glass-row rounded-xl p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-[13px] font-medium text-sky-300 hover:text-sky-200 hover:underline"
                      title={source.title}
                    >
                      {source.title}
                    </a>
                    <span className="text-[11px] text-slate-500">
                      {source.publisher} · {formatDate(source.publishedAt)}
                    </span>
                  </div>
                  <span className="glass-well shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-slate-300">
                    ↗
                  </span>
                </div>
                <div className="mt-2">
                  <BiasBadge bias={source.bias} />
                </div>
                {source.corroborates && source.corroborates.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {source.corroborates.map((claim) => (
                      <span
                        key={claim}
                        className="glass-well rounded-md px-1.5 py-0.5 text-[10px] text-slate-400"
                      >
                        ✓ {claim}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* Related stories — the graph edges, opened or compiled on demand.
            Above the ask box: the whole shelf stays visible without a long
            scroll, so the links read as part of the story, not a footnote. */}
        {story.relatedStories.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Linked stories
            </h3>
            <ul className="space-y-2">
              {story.relatedStories.map((rel) => {
                const ready = isSaved(rel.slug, rel.title, stories);
                return (
                  <li key={rel.slug}>
                    <button
                      type="button"
                      onClick={() => onOpenStory?.(rel.slug, rel.title)}
                      disabled={!onOpenStory}
                      title={ready ? `Open “${rel.title}”` : `Research “${rel.title}” and build its story`}
                      className="glass-row group flex w-full items-start gap-3 rounded-xl p-3 text-left transition hover:border-sky-400/40 hover:bg-sky-400/5 disabled:cursor-default"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-slate-200 group-hover:text-white">
                          {rel.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
                          {rel.relation}
                        </span>
                      </span>
                      <span
                        className={`mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-wide transition ${
                          ready ? "text-slate-500 group-hover:text-sky-300" : "text-violet-300/80 group-hover:text-violet-300"
                        }`}
                      >
                        {ready ? "open ▸" : "map ▸"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Grounded Q&A — Nebius at runtime */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Ask the story
          </h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
            className="flex gap-2"
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What's new in this story?"
              className="glass-well min-w-0 flex-1 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none focus:ring-1 focus:ring-sky-400/40"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-sky-600 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {loading ? "…" : "Ask"}
            </button>
          </form>

          {loading && <div className="shimmer mt-3 h-12 rounded-md" />}

          {error && (
            <p className="mt-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          {answer && (
            <div className="glass-row fade-up mt-3 rounded-xl p-3">
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-300">
                {answer}
              </p>
              {citations.length > 0 && (
                <div className="mt-3 border-t border-slate-800 pt-2">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Cited sources
                  </span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {citations.flatMap((c) =>
                      c.sources.map((s) => (
                        <a
                          key={s.id}
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 hover:border-sky-600 hover:text-sky-300"
                          title={s.title}
                        >
                          {s.publisher} [{c.eventId}]
                        </a>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
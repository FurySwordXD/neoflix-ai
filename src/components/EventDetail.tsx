"use client";

import { useState } from "react";
import type {
  SourceRef,
  Story,
  StoryEvent,
} from "@/lib/types";
import BiasBadge from "./BiasBadge";
import {
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

interface EventDetailProps {
  story: Story;
  event: StoryEvent;
  onClose: () => void;
}

export default function EventDetail({ story, event, onClose }: EventDetailProps) {
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
    <aside className="scroll-slim fade-up flex h-full w-full max-w-md shrink-0 flex-col overflow-y-auto border-l border-slate-800 bg-slate-950/85 backdrop-blur-md">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
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
          </div>
          <button
            onClick={onClose}
            className="rounded-md bg-slate-800/80 px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 hover:text-slate-200"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-6 px-5 py-5">
        {/* Summary — deliberately unopinionated */}
        <p className="text-[13px] leading-relaxed text-slate-300">
          {event.summary}
        </p>

        {/* Sources with bias profiles */}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Sources ({event.sources.length})
          </h3>
          <ul className="space-y-3">
            {event.sources.map((source) => (
              <li
                key={source.id}
                className="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
              >
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
                  <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
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
                        className="rounded bg-slate-800/70 px-1.5 py-0.5 text-[10px] text-slate-400"
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
              className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
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
            <div className="fade-up mt-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
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

        {/* Related stories — the graph edges */}
        {story.relatedStories.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Linked stories
            </h3>
            <ul className="space-y-2">
              {story.relatedStories.map((rel) => (
                <li
                  key={rel.slug}
                  className="rounded-lg border border-dashed border-slate-700 bg-slate-900/40 p-3"
                >
                  <div className="text-[13px] font-medium text-slate-300">
                    {rel.title}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {rel.relation}
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-600">
                    coming to the map soon
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
"use client";

import { useState } from "react";
import type { Story } from "@/lib/types";

interface StoryQueryFormProps {
  onStory: (story: Story, created: boolean) => void;
  onBusy: (busy: boolean, query: string) => void;
}

/**
 * One field. A matching saved story opens immediately; otherwise the topic
 * is compiled into a new story. The reader never pastes links.
 */
export default function StoryQueryForm({ onStory, onBusy }: StoryQueryFormProps) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const topic = query.trim();
    if (topic.length < 2 || busy) return;
    setBusy(true);
    setError(null);
    onBusy(true, topic);
    try {
      const res = await fetch("/api/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: topic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not open that story");
      onStory(data.story as Story, Boolean(data.created));
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that story");
    } finally {
      setBusy(false);
      onBusy(false, "");
    }
  }

  return (
    <form onSubmit={onSubmit} className="relative flex min-w-0 flex-1 items-center gap-2 sm:max-w-md">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Name a story — COVID-19, the Berlin Wall…"
        disabled={busy}
        aria-label="Story topic"
        className="min-w-[8rem] flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={busy || query.trim().length < 2}
        className="shrink-0 rounded-md bg-violet-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
      >
        {busy ? "Mapping…" : "Map"}
      </button>
      {error && (
        <p className="absolute left-0 top-[calc(100%+6px)] z-40 w-full rounded-md border border-red-900/60 bg-red-950/95 px-3 py-2 text-[11px] leading-snug text-red-200 shadow-lg">
          {error}
        </p>
      )}
    </form>
  );
}

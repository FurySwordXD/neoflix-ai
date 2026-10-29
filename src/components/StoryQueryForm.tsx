"use client";

import { useState } from "react";

interface StoryQueryFormProps {
  onSearch: (query: string) => void;
  busy?: boolean;
  variant?: "compact" | "hero";
}

/**
 * One field. A matching saved story opens immediately; otherwise the topic
 * is compiled into a new story on the map, event by event.
 */
export default function StoryQueryForm({
  onSearch,
  busy = false,
  variant = "compact",
}: StoryQueryFormProps) {
  const [query, setQuery] = useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const topic = query.trim();
    if (topic.length < 2 || busy) return;
    setQuery("");
    onSearch(topic);
  }

  return (
    <form
      onSubmit={onSubmit}
      className={
        variant === "hero"
          ? "relative flex w-full items-center gap-2"
          : "relative flex min-w-0 flex-1 items-center gap-2 sm:max-w-md"
      }
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a story"
        disabled={busy}
        aria-label="Story topic"
        className={
          variant === "hero"
            ? "glass-well min-w-0 flex-1 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none focus:ring-1 focus:ring-sky-400/40 disabled:opacity-60"
            : "glass-well min-w-[8rem] flex-1 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none focus:ring-1 focus:ring-sky-400/40 disabled:opacity-60"
        }
      />
      <button
        type="submit"
        disabled={busy || query.trim().length < 2}
        className={
          variant === "hero"
            ? "shrink-0 rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 transition hover:bg-violet-500 disabled:opacity-50"
            : "shrink-0 rounded-lg bg-violet-600/90 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-violet-900/30 transition hover:bg-violet-500 disabled:opacity-50"
        }
      >
        {busy ? "Mapping…" : "Search"}
      </button>
    </form>
  );
}

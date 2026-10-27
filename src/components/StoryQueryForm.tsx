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
            ? "min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none disabled:opacity-60"
            : "min-w-[8rem] flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none disabled:opacity-60"
        }
      />
      <button
        type="submit"
        disabled={busy || query.trim().length < 2}
        className={
          variant === "hero"
            ? "shrink-0 rounded-lg bg-violet-600 px-4 py-3 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            : "shrink-0 rounded-md bg-violet-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        }
      >
        {busy ? "Mapping…" : "Search"}
      </button>
    </form>
  );
}

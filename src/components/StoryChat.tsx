"use client";

import { useEffect, useRef, useState } from "react";
import type { AskCitation, AskTurn } from "@/lib/ask";
import { streamAsk } from "@/lib/readAskStream";
import { newTurnId, useAskHistory } from "@/lib/askHistory";
import { MAX_HISTORY_MESSAGES } from "@/lib/ask";

/**
 * "Ask the story": a grounded, streaming chat over one story's event
 * records, answered by Nemotron Nano. The thread lives in the reader's
 * browser — it survives reloads and switching events — and the server
 * stays stateless, taking the recent turns with each request.
 */

interface StoryChatProps {
  slug: string;
  /** The story's events, so the suggested openers quote real beats. */
  events: Array<{ title: string }>;
  /** Jump to a cited event on the timeline. */
  onShowEvent?: (eventId: string) => void;
}

/** A short time label for a turn. */
function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Suggested openers, generated from the story's own beats. */
function starterQuestions(titles: string[]): string[] {
  const starters: string[] = ["What is this story about?"];
  if (titles.length > 1) {
    starters.push(`How did things change between "${titles[0]}" and "${titles[titles.length - 1]}"?`);
  }
  if (titles.length === 1) starters.push(`Why did "${titles[0]}" happen?`);
  return starters;
}

/** Render answer text with [e01]-style markers as clickable chips. */
function AnswerText({ text, onCite }: { text: string; onCite?: (eventId: string) => void }) {
  const parts = text.split(/(\[(?:e\d{2}|g\d{3})\])/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\[(?:e\d{2}|g\d{3})\]$/.test(part) ? (
          <button
            key={i}
            type="button"
            onClick={() => onCite?.(part.slice(1, -1))}
            title={`Show event ${part.slice(1, -1)} on the timeline`}
            className="mx-0.5 inline translate-y-[-1px] rounded-full border border-sky-500/50 bg-sky-500/10 px-1.5 py-px align-baseline text-[10px] font-semibold text-sky-300 transition hover:bg-sky-500/25 hover:text-sky-200"
          >
            {part.slice(1, -1)}
          </button>
        ) : (
          part
        )
      )}
    </>
  );
}

/** The sources behind an answer's citations. */
function CitationSources({ citations }: { citations: AskCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <div className="mt-2 border-t border-slate-700/60 pt-2">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">Cited sources</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {citations.flatMap((c) =>
          c.sources.map((s) => (
            <a
              key={s.id}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              title={s.title}
              className="rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 transition hover:border-sky-600 hover:text-sky-300"
            >
              {s.publisher} [{c.eventId}]
            </a>
          ))
        )}
      </div>
    </div>
  );
}

/** The message list — a real chat thread. */
function Thread({
  turns,
  pending,
  pendingText,
  error,
  onCite,
}: {
  turns: AskTurn[];
  pending: boolean;
  pendingText: string;
  error: string | null;
  onCite?: (eventId: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** True until the reader scrolls up, so streaming never yanks them back. */
  const pinnedRef = useRef(true);

  // Keep the newest message in view while the thread grows or streams —
  // but only while the reader is already at the bottom.
  useEffect(() => {
    if (pinnedRef.current) {
      endRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [turns.length, pendingText, error]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  if (turns.length === 0 && !pending) return null;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="scroll-slim mt-3 max-h-72 space-y-3 overflow-y-auto rounded-xl bg-slate-950/40 p-3"
    >
      {turns.map((turn) =>
        turn.role === "user" ? (
          <div key={turn.id} className="flex flex-col items-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-sky-600/90 px-3 py-2 text-left text-[12px] leading-relaxed text-white">
              {turn.content}
            </div>
            <span className="mt-0.5 text-[9px] text-slate-600">{timeLabel(turn.at)}</span>
          </div>
        ) : (
          <div key={turn.id} className="flex flex-col items-start">
            <div className="glass-row max-w-[95%] rounded-2xl rounded-bl-md p-3">
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-200">
                <AnswerText text={turn.content} onCite={onCite} />
              </p>
              {turn.citations && turn.citations.length > 0 && (
                <CitationSources citations={turn.citations} />
              )}
            </div>
            <span className="mt-0.5 text-[9px] text-slate-600">{timeLabel(turn.at)}</span>
          </div>
        )
      )}

      {pending && (
        <div className="flex flex-col items-start">
          <div className="glass-row max-w-[95%] rounded-2xl rounded-bl-md p-3">
            {pendingText ? (
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-200">
                {pendingText}
              </p>
            ) : (
              <div className="shimmer h-3 w-24 rounded-md" />
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div ref={endRef} />
    </div>
  );
}

export default function StoryChat({ slug, events, onShowEvent }: StoryChatProps) {
  const [turns, { append, clear }] = useAskHistory(slug);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingText, setPendingText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const starters = starterQuestions(events.map((e) => e.title));

  async function submit(q: string) {
    const text = q.trim();
    if (!text || pending) return;
    setPending(true);
    setPendingText("");
    setError(null);
    setQuestion("");

    const userTurn: AskTurn = { id: newTurnId(), role: "user", content: text, at: Date.now() };
    append(userTurn);

    try {
      // What the server may see of the thread: the most recent turns
      // before this question, newest kept, cap enforced server-side too.
      const history = [...turns, userTurn]
        .slice(-(MAX_HISTORY_MESSAGES + 1), -1)
        .map((t) => ({ role: t.role, content: t.content }));
      const { answer, citations } = await streamAsk(
        { slug, question: text, history },
        (delta) => setPendingText((prev) => prev + delta)
      );
      append({ id: newTurnId(), role: "assistant", content: answer, citations, at: Date.now() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPending(false);
      setPendingText("");
    }
  }

  return (
    <section className="mt-1">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Ask the story
        </h3>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="text-[10px] text-slate-500 underline-offset-2 transition hover:text-slate-300 hover:underline"
          >
            Clear chat
          </button>
        )}
      </div>

      {turns.length === 0 && (
        <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
          Ask anything about this story. Answers come only from its event records, with citations.
          The chat history stays in this browser.
        </p>
      )}

      <Thread
        turns={turns}
        pending={pending}
        pendingText={pendingText}
        error={error}
        onCite={onShowEvent}
      />

      {turns.length === 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {starters.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => submit(s)}
              className="glass-well rounded-full px-2.5 py-1 text-left text-[11px] text-slate-400 transition hover:text-sky-300"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
        className="mt-2 flex gap-2"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about causes, consequences, who's involved…"
          maxLength={500}
          disabled={pending}
          className="glass-well min-w-0 flex-1 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none focus:ring-1 focus:ring-sky-400/40 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || !question.trim()}
          className="shrink-0 rounded-md bg-sky-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50"
        >
          {pending ? "…" : "Ask"}
        </button>
      </form>
    </section>
  );
}

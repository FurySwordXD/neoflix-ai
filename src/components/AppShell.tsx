"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Dashboard from "@/components/Dashboard";
import StoryMapApp from "@/components/StoryMapApp";
import { readStoryRefresh, readStoryStream } from "@/lib/readStoryStream";
import { useReaderProfile, withOpen } from "@/lib/profile";
import type { TrendItem } from "@/lib/recommend";
import { findExistingStory } from "@/lib/storyMatch";
import type { StoryMeta } from "@/lib/stories";
import type { Story, StoryEvent } from "@/lib/types";
import type { StoryStreamMeta } from "@/lib/storyStream";

/** How long a just-added event stays put when the next one arrives immediately. */
const REVEAL_GAP_MS = 450;

/** Story deletion (and its recreate shortcut) never ships: it is a dev tool. */
const DEV_TOOLS = process.env.NODE_ENV !== "production";

interface AppShellProps {
  initialStory: Story | null;
  stories: Array<Pick<Story, "slug" | "title" | "status">>;
  metas: StoryMeta[];
  /** Topics from the db: trending graph topics plus the saved-story shelf. */
  trends?: TrendItem[];
}

type Phase =
  | { mode: "browse" }
  | {
      mode: "story";
      story: Story;
      generating: boolean;
      error: string | null;
      generation: number;
      steps: string[];
    };

/** An in-flight update pass over an open story: streamed like a generation. */
interface RefreshState {
  steps: string[];
  error: string | null;
}

/** Transient line under the header when an update found nothing new. */
const UP_TO_DATE_NOTICE = "No new developments — this story is already up to date.";

function draftStory(query: string): Story {
  return {
    slug: "generating",
    title: query,
    subtitle: "Finding the events",
    description: "",
    status: "ongoing",
    startAt: new Date().toISOString(),
    queries: [query],
    relatedStories: [],
    events: [],
  };
}

function applyMeta(story: Story, meta: StoryStreamMeta): Story {
  const status = meta.status ?? story.status;
  const next: Story = {
    ...story,
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.subtitle ? { subtitle: meta.subtitle } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.hook ? { hook: meta.hook } : {}),
    status,
  };
  if (status === "ongoing") return { ...next, endAt: undefined };
  if (next.events.length > 0) {
    return { ...next, endAt: next.events[next.events.length - 1].timestamp };
  }
  return next;
}

function applyEvent(story: Story, event: StoryEvent): Story {
  if (story.events.some((item) => item.id === event.id)) return story;
  const events = [...story.events, event].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)
  );
  return {
    ...story,
    events,
    startAt: events[0].timestamp,
    endAt: story.status === "concluded" ? events[events.length - 1].timestamp : story.endAt,
  };
}

export default function AppShell({ initialStory, stories, metas, trends }: AppShellProps) {
  const [phase, setPhase] = useState<Phase>(() =>
    initialStory
      ? { mode: "story", story: initialStory, generating: false, error: null, generation: 0, steps: [] }
      : { mode: "browse" }
  );
  const [, updateProfile] = useReaderProfile();
  const router = useRouter();
  const live = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const topicsRef = useRef<string[] | null>(null);
  const initialSlug = initialStory?.slug ?? "";
  const metasRef = useRef(metas);
  metasRef.current = metas;
  const [refreshing, setRefreshing] = useState(false);
  const [refresh, setRefresh] = useState<RefreshState | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  // Dev-only delete/recreate in flight; buttons disable while it runs.
  const [deleting, setDeleting] = useState(false);
  // Slugs deleted this session; the rail filters them out until one exists again.
  const [removedSlugs, setRemovedSlugs] = useState<string[]>([]);

  useEffect(() => {
    if (live.current) return;
    // A new story view starts clean: drop any refresh still in flight.
    refreshAbortRef.current?.abort();
    setRefreshing(false);
    setRefresh(null);
    setRefreshNotice(null);
    if (initialStory) {
      setPhase({
        mode: "story",
        story: initialStory,
        generating: false,
        error: null,
        generation: 0,
        steps: [],
      });
    } else {
      setPhase({ mode: "browse" });
    }
  }, [initialSlug, initialStory]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      refreshAbortRef.current?.abort();
    };
  }, []);

  function begin(query: string, topics?: string[]) {
    const topic = query.trim();
    if (topic.length < 2) return;
    abortRef.current?.abort();
    refreshAbortRef.current?.abort();
    setRefreshing(false);
    setRefresh(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const id = ++generationRef.current;
    live.current = true;
    topicsRef.current = topics && topics.length > 0 ? topics : null;
    window.history.replaceState(null, "", "/");
    setPhase({
      mode: "story",
      story: draftStory(topic),
      generating: true,
      error: null,
      generation: id,
      steps: [],
    });

    let shownAt = 0;
    const pauseForReveal = async () => {
      const gap = Date.now() - shownAt;
      if (shownAt !== 0 && gap < REVEAL_GAP_MS) {
        await new Promise((resolve) => setTimeout(resolve, REVEAL_GAP_MS - gap));
      }
    };

    void (async () => {
      try {
        await readStoryStream(topic, {
          signal: controller.signal,
          onStep(step) {
            if (generationRef.current !== id) return;
            setPhase((current) => {
              if (current.mode !== "story" || current.generation !== id) return current;
              const last = current.steps[current.steps.length - 1];
              if (last === step) return current;
              return { ...current, steps: [...current.steps, step] };
            });
          },
          onMeta(meta) {
            if (generationRef.current !== id) return;
            setPhase((current) => {
              if (current.mode !== "story" || current.generation !== id) return current;
              return { ...current, story: applyMeta(current.story, meta) };
            });
          },
          async onEvent(event) {
            await pauseForReveal();
            if (controller.signal.aborted || generationRef.current !== id) return;
            setPhase((current) => {
              if (current.mode !== "story" || current.generation !== id) return current;
              return { ...current, story: applyEvent(current.story, event) };
            });
            shownAt = Date.now();
          },
          async onStory(next) {
            await pauseForReveal();
            if (controller.signal.aborted || generationRef.current !== id) return;
            live.current = false;
            updateProfile((current) => withOpen(current, topicsRef.current ?? []));
            window.history.replaceState(null, "", `/?story=${encodeURIComponent(next.slug)}`);
            // A recreate may land on the slug it just deleted; stop hiding it.
            setRemovedSlugs((current) => current.filter((item) => item !== next.slug));
            setPhase({
              mode: "story",
              story: next,
              generating: false,
              error: null,
              generation: id,
              steps: [],
            });
          },
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        live.current = false;
        const message = err instanceof Error ? err.message : "Could not open that story";
        setPhase((current) =>
          current.mode === "story" && current.generation === id
            ? { ...current, generating: false, error: message }
            : current
        );
      }
    })();
  }

  // A related story card: open the saved one, or research it live. Saved can
  // mean the exact stub slug, or a different slug whose title matches — the
  // model slugs a related story from its own title, which may drift from
  // the slug the real story lands under.
  function openRelated(slug: string, title: string) {
    if (phase.mode === "story" && phase.generating) return;
    const metas = metasRef.current;
    const exact = metas.some((meta) => meta.slug === slug) ? slug : null;
    const target = exact ?? findExistingStory(title, metas)?.slug ?? null;
    if (target) {
      router.push(`/?story=${encodeURIComponent(target)}`);
      return;
    }
    begin(title);
  }

  // Pull the latest news into the open story. New events stream in like a
  // generation; the story itself stays open and readable the whole time.
  function refreshStory() {
    if (phase.mode !== "story" || phase.generating) return;
    const slug = phase.story.slug;
    if (slug === "generating") return;
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setRefreshing(true);
    setRefresh({ steps: [], error: null });
    setRefreshNotice(null);

    void (async () => {
      try {
        await readStoryRefresh(slug, {
          signal: controller.signal,
          onStep(step) {
            if (controller.signal.aborted) return;
            setRefresh((current) =>
              current && !current.steps.includes(step)
                ? { ...current, steps: [...current.steps, step] }
                : current
            );
          },
          onEvent(event) {
            if (controller.signal.aborted) return;
            // Only apply updates while this story is still the one on screen.
            setPhase((current) =>
              current.mode === "story" && current.story.slug === slug
                ? { ...current, story: applyEvent(current.story, event) }
                : current
            );
          },
          onStory(next, _created, added) {
            if (controller.signal.aborted) return;
            setPhase((current) =>
              current.mode === "story" && current.story.slug === next.slug
                ? { ...current, story: next }
                : current
            );
            if (added === 0) setRefreshNotice(UP_TO_DATE_NOTICE);
          },
        });
        setRefreshing(false);
        setRefresh(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Could not refresh that story";
        setRefreshing(false);
        setRefresh({ steps: [], error: message });
      }
    })();
  }

  // Dev-only: DELETE the saved story, then either reopen the dashboard or
  // re-run the founding query so a fresh compile takes the story's place.
  function deleteStory() {
    void requestDelete(null);
  }

  // Recreate: delete, then re-run the story's most recent query. The fresh
  // compile may land on a different slug if the new title drifts.
  function recreateStory() {
    if (phase.mode !== "story") return;
    const query = phase.story.queries?.[phase.story.queries.length - 1];
    if (!query) {
      deleteStory();
      return;
    }
    void requestDelete(query);
  }

  /** DELETEs the saved story; with a query it immediately generates a replacement. */
  async function requestDelete(recreateQuery: string | null) {
    if (phase.mode !== "story" || phase.generating || deleting) return;
    const slug = phase.story.slug;
    if (slug === "generating") return;
    // An in-flight update pass over a story that is about to vanish is dead weight.
    refreshAbortRef.current?.abort();
    setRefreshing(false);
    setRefresh(null);
    setRefreshNotice(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/stories/${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(
          typeof data?.error === "string" && data.error ? data.error : "Could not delete that story"
        );
      }
      setRemovedSlugs((current) => (current.includes(slug) ? current : [...current, slug]));
      setDeleting(false);
      if (recreateQuery) begin(recreateQuery);
      else router.push("/");
    } catch (err) {
      setDeleting(false);
      console.error(err instanceof Error ? err.message : err);
    }
  }

  if (phase.mode === "browse") {
    return <Dashboard metas={metas} trends={trends} onGenerate={begin} />;
  }

  return (
    <StoryMapApp
      story={phase.story}
      stories={stories}
      generating={phase.generating}
      generation={phase.generation}
      generationError={phase.error}
      steps={phase.steps}
      onGenerate={begin}
      refreshing={refreshing}
      refreshSteps={refresh?.steps ?? []}
      refreshError={refresh?.error ?? null}
      refreshNotice={refreshNotice}
      onRefresh={refreshStory}
      onOpenStory={openRelated}
      onDeleteStory={DEV_TOOLS ? deleteStory : undefined}
      onRecreateStory={DEV_TOOLS ? recreateStory : undefined}
      deleting={deleting}
      removedSlugs={removedSlugs}
    />
  );
}

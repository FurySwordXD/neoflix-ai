"use client";

import { useEffect, useRef, useState } from "react";
import Dashboard from "@/components/Dashboard";
import StoryMapApp from "@/components/StoryMapApp";
import { readStoryStream } from "@/lib/readStoryStream";
import { useReaderProfile, withOpen } from "@/lib/profile";
import { topicsForSlug } from "@/lib/recommend";
import type { StoryMeta } from "@/lib/stories";
import type { Story, StoryEvent } from "@/lib/types";
import type { StoryStreamMeta } from "@/lib/storyStream";

/** How long a just-added event stays put when the next one arrives immediately. */
const REVEAL_GAP_MS = 450;

interface AppShellProps {
  initialStory: Story | null;
  stories: Array<Pick<Story, "slug" | "title" | "status">>;
  metas: StoryMeta[];
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

export default function AppShell({ initialStory, stories, metas }: AppShellProps) {
  const [phase, setPhase] = useState<Phase>(() =>
    initialStory
      ? { mode: "story", story: initialStory, generating: false, error: null, generation: 0, steps: [] }
      : { mode: "browse" }
  );
  const [, updateProfile] = useReaderProfile();
  const live = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const topicsRef = useRef<string[] | null>(null);
  const initialSlug = initialStory?.slug ?? "";

  useEffect(() => {
    if (live.current) return;
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
    return () => abortRef.current?.abort();
  }, []);

  function begin(query: string, topics?: string[]) {
    const topic = query.trim();
    if (topic.length < 2) return;
    abortRef.current?.abort();
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
            const picked = topicsRef.current ?? topicsForSlug(next.slug);
            updateProfile((current) => withOpen(current, picked));
            window.history.replaceState(null, "", `/?story=${encodeURIComponent(next.slug)}`);
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

  if (phase.mode === "browse") {
    return <Dashboard metas={metas} onGenerate={begin} />;
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
    />
  );
}

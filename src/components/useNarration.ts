"use client";

import { useEffect, useRef, useState } from "react";
import type { StoryEvent } from "@/lib/types";

export type NarrationStatus = "off" | "idle" | "loading" | "playing" | "paused" | "done" | "error";
export type ScriptStatus = "idle" | "loading" | "ready" | "error";

interface VoiceoverResponse {
  script: string;
  audioUrl: string | null;
}

const voiceoverCache = new Map<string, Promise<VoiceoverResponse>>();

/** Fetches one clip, sharing in-flight and settled requests like a warm cache. */
function fetchVoiceover(slug: string, eventId: string): Promise<VoiceoverResponse> {
  const key = `${slug}/${eventId}`;
  let pending = voiceoverCache.get(key);
  if (!pending) {
    pending = fetch(`/api/stories/${slug}/events/${eventId}/voiceover`).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Voice-over failed");
      return data as VoiceoverResponse;
    });
    // Don't cache failures, so the next attempt retries.
    pending.catch(() => voiceoverCache.delete(key));
    voiceoverCache.set(key, pending);
  }
  return pending;
}

/**
 * Fetches every clip for the story in one request, seeding the per-clip
 * cache so playback never waits on a per-event round trip. Errors are
 * swallowed — narration still works per clip on demand.
 */
export function warmStoryVoiceovers(slug: string): void {
  void fetch(`/api/stories/${slug}/voiceover`)
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Voice-over failed");
      for (const clip of data.voiceovers as Array<{
        eventId: string;
        script: string | null;
        audioUrl: string | null;
      }>) {
        // A null script means that clip failed server-side; leaving it out of
        // the cache lets the per-event route retry it on demand.
        if (clip.script) {
          voiceoverCache.set(
            `${slug}/${clip.eventId}`,
            Promise.resolve({ script: clip.script, audioUrl: clip.audioUrl })
          );
        }
      }
    })
    .catch(() => {});
}

interface UseNarrationOptions {
  enabled: boolean;
  /** Story transport is paused. The current clip holds its place and continues on resume. */
  paused: boolean;
  slug: string;
  event: StoryEvent | null;
  // Speech gets faster with playback speed, but stays intelligible.
  rate: number;
}

/**
 * Loads the focused event's voice-over script whether or not audio is playing.
 * When enabled, plays cached TTS audio, otherwise the browser's speech synthesis.
 */
export function useNarration({ enabled, paused, slug, event, rate }: UseNarrationOptions) {  const audioRef = useRef<HTMLAudioElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const clipRef = useRef<VoiceoverResponse | null>(null);
  const speechStartedRef = useRef(false);
  const statusRef = useRef<NarrationStatus>("off");
  const rateRef = useRef(rate);
  const pausedRef = useRef(paused);
  const [status, setStatus] = useState<NarrationStatus>("off");
  const [script, setScript] = useState<string | null>(null);
  const [scriptStatus, setScriptStatus] = useState<ScriptStatus>("idle");
  const [progress, setProgress] = useState(0);

  rateRef.current = rate;
  pausedRef.current = paused;
  statusRef.current = status;

  function setNarrationStatus(next: NarrationStatus) {
    statusRef.current = next;
    setStatus(next);
  }

  useEffect(() => {
    audioRef.current = new Audio();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop() {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = audio.onerror = audio.ontimeupdate = null;
      audio.pause();
    }
    if (utteranceRef.current) {
      utteranceRef.current.onend = utteranceRef.current.onerror = null;
      utteranceRef.current.onboundary = null;
      utteranceRef.current = null;
      window.speechSynthesis?.cancel();
    }
    clipRef.current = null;
    speechStartedRef.current = false;
  }

  function playClip(vo: VoiceoverResponse) {
    if (vo.audioUrl && audioRef.current) {
      const audio = audioRef.current;
      if (audio.src !== new URL(vo.audioUrl, window.location.href).href) {
        audio.src = vo.audioUrl;
      }
      audio.defaultPlaybackRate = rateRef.current;
      audio.playbackRate = rateRef.current;
      audio.ontimeupdate = () => {
        if (audio.duration) setProgress(audio.currentTime / audio.duration);
      };
      audio.onended = () => {
        setProgress(1);
        setNarrationStatus("done");
      };
      audio.onerror = () => setNarrationStatus("error");
      if (pausedRef.current || (!audio.paused && !audio.ended)) return;
      audio
        .play()
        .then(() => {
          if (!pausedRef.current) setNarrationStatus("playing");
        })
        .catch((err: unknown) => {
          if (pausedRef.current) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setNarrationStatus("error");
        });
      return;
    }

    if (!window.speechSynthesis) {
      setNarrationStatus("error");
      return;
    }
    if (speechStartedRef.current) {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      if (!pausedRef.current) setNarrationStatus("playing");
      return;
    }
    if (pausedRef.current) {
      setNarrationStatus("paused");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(vo.script);
    utterance.rate = rateRef.current;
    utterance.onboundary = (e) => setProgress(e.charIndex / vo.script.length);
    utterance.onend = () => {
      setProgress(1);
      setNarrationStatus("done");
    };
    utterance.onerror = () => setNarrationStatus("error");
    utteranceRef.current = utterance;
    speechStartedRef.current = true;
    window.speechSynthesis.speak(utterance);
    setNarrationStatus("playing");
  }

  function pauseClip() {
    const audio = audioRef.current;
    if (audio && !audio.paused) audio.pause();
    if (window.speechSynthesis?.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
    }
    if (statusRef.current === "playing") setNarrationStatus("paused");
  }

  const eventId = event?.id ?? null;

  useEffect(() => {
    if (!eventId) {
      setScript(null);
      setScriptStatus("idle");
      return;
    }

    let cancelled = false;
    setScript(null);
    setScriptStatus("loading");
    fetchVoiceover(slug, eventId)
      .then((vo) => {
        if (cancelled) return;
        setScript(vo.script);
        setScriptStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setScript(null);
        setScriptStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [slug, eventId]);

  useEffect(() => {
    stop();
    setProgress(0);
    if (!enabled) {
      setNarrationStatus("off");
      return;
    }
    if (!eventId) {
      setNarrationStatus("idle");
      return;
    }

    let cancelled = false;
    setNarrationStatus("loading");

    fetchVoiceover(slug, eventId)
      .then((vo) => {
        if (cancelled) return;
        clipRef.current = vo;
        setScript(vo.script);
        if (pausedRef.current) {
          if (vo.audioUrl && audioRef.current) audioRef.current.src = vo.audioUrl;
          setNarrationStatus("paused");
          return;
        }
        playClip(vo);
      })
      .catch(() => !cancelled && setNarrationStatus("error"));

    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, slug, eventId]);

  useEffect(() => {
    if (!enabled) return;
    if (paused) {
      pauseClip();
      return;
    }
    const clip = clipRef.current;
    if (clip && statusRef.current !== "done" && statusRef.current !== "error") {
      playClip(clip);
    }
    // pauseClip/playClip close over the latest refs; re-run only when transport changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, enabled]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
    }
  }, [rate]);

  return { status, script, scriptStatus, progress };
}

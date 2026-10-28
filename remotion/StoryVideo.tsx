import { Audio } from "@remotion/media";
import { useState } from "react";
import { AbsoluteFill, Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import type { VideoImage } from "./types";
import { motionCaption } from "../src/lib/mapMotion";
import { CATEGORY_COLORS, CATEGORY_LABELS, LEAN_COLORS, formatMagnitude } from "../src/lib/ui";
import { EarthScene } from "./EarthScene";
import { captionPages, activeCaptionPage } from "./captions";
import { formatLongDate, formatRange } from "./format";
import { aimAt, lerpAngle } from "./geo";
import type { VideoEvent, VideoManifest } from "./types";

// A type alias (not an interface): Remotion's Composition requires props to
// satisfy `Record<string, unknown>`, which needs an implicit index signature
// that interfaces don't get.
export type StoryVideoProps = {
  slug: string;
  manifest: VideoManifest | null;
};

const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

function aimForFrame(frame: number, events: VideoEvent[], titleFrames: number, endStart: number) {
  const first = aimAt(events[0].location.lat, events[0].location.lng);
  if (frame < titleFrames) {
    const t = interpolate(frame, [0, titleFrames], [0, 1], {
      easing: Easing.inOut(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    return {
      yaw: lerpAngle(first.yaw - 0.85, first.yaw, t),
      pitch: lerpAngle(first.pitch * 0.15, first.pitch, t),
    };
  }

  let index = 0;
  for (let i = 0; i < events.length; i++) {
    if (frame >= events[i].from) index = i;
  }
  const current = aimAt(events[index].location.lat, events[index].location.lng);
  const previous = index > 0 ? aimAt(events[index - 1].location.lat, events[index - 1].location.lng) : null;
  const local = frame - events[index].from;
  const flyFrames = 24;
  let aim = current;
  if (previous && local < flyFrames) {
    const t = interpolate(local, [0, flyFrames], [0, 1], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    aim = {
      yaw: lerpAngle(previous.yaw, current.yaw, t),
      pitch: lerpAngle(previous.pitch, current.pitch, t),
    };
  }
  if (frame >= endStart) {
    aim = { yaw: aim.yaw + (frame - endStart) * 0.0035, pitch: aim.pitch * 0.92 };
  }
  return aim;
}

function slideForFrame(frame: number, titleFrames: number, endStart: number) {
  const inEnd = Math.min(titleFrames + 20, endStart);
  if (frame <= titleFrames) return 0;
  if (frame < inEnd) {
    return interpolate(frame, [titleFrames, inEnd], [0, -0.72], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }
  if (frame < endStart) return -0.72;
  return interpolate(frame, [endStart, endStart + 20], [-0.72, 0], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function activeEvent(frame: number, events: VideoEvent[], endStart: number): VideoEvent | null {
  if (frame < events[0].from || frame >= endStart) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (frame >= events[i].from) return events[i];
  }
  return null;
}

export function StoryVideo({ manifest }: StoryVideoProps) {
  const frame = useCurrentFrame();
  if (!manifest || manifest.events.length === 0) {
    return (
      <AbsoluteFill style={{ backgroundColor: "#050810", color: "#e2e8f0", fontFamily: FONT }}>
        <div style={{ margin: "auto", fontSize: 28 }}>Stage a story before rendering.</div>
      </AbsoluteFill>
    );
  }

  const { events, titleFrames } = manifest;
  const endStart = manifest.durationInFrames - manifest.endFrames;
  const event = activeEvent(frame, events, endStart);
  const revealed =
    frame >= endStart ? events.length : events.filter((item) => frame >= item.from - 8).length || (frame > titleFrames * 0.4 ? 1 : 0);
  const activeIndex = Math.max(0, Math.min(events.length, revealed) - 1);
  const aim = aimForFrame(frame, events, titleFrames, endStart);
  const shift = slideForFrame(frame, titleFrames, endStart);

  const titleOpacity = interpolate(frame, [0, 16, titleFrames - 14, titleFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const endOpacity = interpolate(frame, [endStart, endStart + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const panelIn = event
    ? interpolate(frame - event.from, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 0;
  const panelOut = interpolate(frame, [endStart - 10, endStart], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const panelOpacity = panelIn * panelOut;

  return (
    <AbsoluteFill style={{ backgroundColor: "#050810", fontFamily: FONT, color: "#e2e8f0" }}>
      <EarthScene
        events={events}
        frame={frame}
        revealed={revealed}
        activeIndex={activeIndex}
        aim={aim}
        shift={shift}
        illustrateId={event?.id ?? null}
        motionFrame={event ? Math.max(0, frame - event.from) : 0}
      />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at 30% 46%, transparent 28%, rgba(5,8,16,0.28) 62%, rgba(5,8,16,0.72) 100%)",
          pointerEvents: "none",
        }}
      />

      <Header title={manifest.title} showStory={frame >= titleFrames && frame < endStart} />

      {titleOpacity > 0.01 ? (
        <TitleCard manifest={manifest} opacity={titleOpacity} />
      ) : null}

      {event && panelOpacity > 0.01 ? (
        <EventPanel event={event} index={activeIndex} total={events.length} opacity={panelOpacity} />
      ) : null}

      {event?.script && panelOpacity > 0.01 ? (
        <Caption
          text={event.script}
          elapsed={frame - event.from}
          durationInFrames={event.durationInFrames}
          opacity={panelOpacity}
        />
      ) : null}

      {frame >= titleFrames && frame < endStart ? (
        <Timeline events={events} frame={frame} endStart={endStart} />
      ) : null}

      {endOpacity > 0.01 ? <EndCard manifest={manifest} opacity={endOpacity} /> : null}

      {events.map((item) =>
        item.audio ? (
          <Sequence
            key={item.id}
            from={item.from + manifest.audioDelayFrames}
            durationInFrames={Math.max(1, item.durationInFrames - manifest.audioDelayFrames)}
            premountFor={20}
          >
            <Audio src={staticFile(item.audio)} />
          </Sequence>
        ) : null
      )}
    </AbsoluteFill>
  );
}

function Header({ title, showStory }: { title: string; showStory: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 28,
        left: 40,
        right: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>🌍</span>
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.28em", color: "#e2e8f0" }}>
          WORLDNEWS
        </span>
      </div>
      {showStory ? (
        <div
          style={{
            maxWidth: 760,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 15,
            color: "#94a3b8",
          }}
        >
          {title}
        </div>
      ) : null}
    </div>
  );
}

function TitleCard({ manifest, opacity }: { manifest: VideoManifest; opacity: number }) {
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 460,
          background: "linear-gradient(to top, rgba(5,8,16,0.96) 18%, rgba(5,8,16,0) 100%)",
        }}
      />
      <div style={{ position: "absolute", left: 72, right: 72, bottom: 78 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.32em", color: "#7dd3fc" }}>
          A SOURCED STORY
        </div>
        <h1
          style={{
            margin: "14px 0 0",
            maxWidth: 1180,
            fontSize: 62,
            lineHeight: 1.05,
            fontWeight: 700,
            color: "white",
          }}
        >
          {manifest.title}
        </h1>
        <p style={{ margin: "16px 0 0", maxWidth: 860, fontSize: 24, lineHeight: 1.35, color: "#cbd5e1" }}>
          {manifest.hook ?? manifest.subtitle}
        </p>
        <p style={{ margin: "14px 0 0", fontSize: 16, color: "#94a3b8" }}>
          {manifest.eventCount} events
          {manifest.narratedCount > 0 ? ` · ${manifest.narratedCount} narrated` : ""} ·{" "}
          {formatRange(manifest.startAt, manifest.endAt)}
        </p>
      </div>
    </div>
  );
}

function EventPanel({
  event,
  index,
  total,
  opacity,
}: {
  event: VideoEvent;
  index: number;
  total: number;
  opacity: number;
}) {
  const color = CATEGORY_COLORS[event.category];
  // Manifests staged before images existed are still on disk, so stay defensive.
  const photo = event.images?.[0];
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 700,
        opacity,
        background:
          "linear-gradient(to right, rgba(5,8,16,0) 0%, rgba(5,8,16,0.72) 16%, rgba(5,8,16,0.94) 38%)",
        padding: "108px 64px 130px 120px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            borderRadius: 4,
            padding: "3px 8px",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color,
            backgroundColor: `${color}22`,
            border: `1px solid ${color}66`,
          }}
        >
          {CATEGORY_LABELS[event.category]}
        </span>
        <span style={{ fontSize: 13, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
          {index + 1} / {total}
        </span>
      </div>
      <h2
        style={{
          margin: "16px 0 0",
          fontSize: 40,
          lineHeight: 1.12,
          fontWeight: 700,
          color: "white",
        }}
      >
        {event.title}
      </h2>
      {photo ? <EventPhoto image={photo} /> : null}
      <p style={{ margin: "12px 0 0", fontSize: 16, color: "#94a3b8" }}>
        {formatLongDate(event.timestamp)} · {event.location.name}, {event.location.country}
        {event.magnitude ? ` · scale ${formatMagnitude(event.magnitude)}` : ""}
      </p>
      {event.motion ? (
        <p style={{ margin: "8px 0 0", fontSize: 15, color: "#7dd3fc" }}>{motionCaption(event.motion)}</p>
      ) : null}
      <p
        style={{
          margin: "22px 0 0",
          fontSize: 18,
          lineHeight: 1.5,
          color: "#cbd5e1",
          display: "-webkit-box",
          WebkitLineClamp: photo ? 4 : 8,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {event.summary}
      </p>
      <div style={{ marginTop: "auto" }}>
        <div style={{ marginBottom: 10, fontSize: 12, fontWeight: 700, letterSpacing: "0.18em", color: "#64748b" }}>
          SOURCES
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {event.sources.slice(0, 4).map((source) => (
            <span
              key={source.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                borderRadius: 999,
                border: "1px solid #1e293b",
                background: "rgba(15,23,42,0.85)",
                padding: "5px 11px",
                fontSize: 14,
                color: "#cbd5e1",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 99,
                  background: LEAN_COLORS[source.politicalLean] ?? LEAN_COLORS.mixed,
                }}
              />
              {source.publisher}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The event's photograph. These URLs come from live research, so the render
 * must survive a dead link: `onImageError` swallows the failure (without it
 * Remotion cancels the whole render) and the frame simply drops the photo.
 */
function EventPhoto({ image }: { image: VideoImage }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <Img
        src={image.url}
        onImageError={() => setBroken(true)}
        delayRenderTimeoutInMilliseconds={15_000}
        style={{
          width: "100%",
          height: 250,
          objectFit: "cover",
          borderRadius: 10,
          border: "1px solid #1e293b",
          backgroundColor: "#0b1120",
        }}
      />
      {image.caption ? (
        <p style={{ margin: "7px 0 0", fontSize: 13, lineHeight: 1.35, color: "#94a3b8" }}>
          {image.caption}
        </p>
      ) : null}
    </div>
  );
}

function Caption({
  text,
  elapsed,
  durationInFrames,
  opacity,
}: {
  text: string;
  elapsed: number;
  durationInFrames: number;
  opacity: number;
}) {
  const pages = captionPages(text, durationInFrames);
  const page = activeCaptionPage(pages, elapsed);
  if (!page) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 48,
        right: 740,
        bottom: 78,
        display: "flex",
        justifyContent: "center",
        opacity,
      }}
    >
      <div
        style={{
          maxWidth: 820,
          borderRadius: 14,
          border: "1px solid rgba(56,189,248,0.28)",
          background: "rgba(2,6,16,0.78)",
          padding: "14px 22px",
          fontSize: 22,
          lineHeight: 1.35,
          color: "white",
          textAlign: "center",
        }}
      >
        {page.lines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </div>
    </div>
  );
}

function Timeline({ events, frame, endStart }: { events: VideoEvent[]; frame: number; endStart: number }) {
  return (
    <div style={{ position: "absolute", left: 48, right: 48, bottom: 32, height: 22 }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "50%",
          height: 3,
          transform: "translateY(-50%)",
          borderRadius: 99,
          background: "rgba(51,65,85,0.85)",
        }}
      />
      {events.map((event, index) => {
        const left = events.length === 1 ? 50 : (index / (events.length - 1)) * 100;
        const reached = frame >= event.from;
        const current = frame >= event.from && frame < event.from + event.durationInFrames && frame < endStart;
        const color = CATEGORY_COLORS[event.category];
        return (
          <div
            key={event.id}
            style={{
              position: "absolute",
              left: `${left}%`,
              top: "50%",
              width: current ? 14 : 9,
              height: current ? 14 : 9,
              transform: "translate(-50%, -50%)",
              borderRadius: 99,
              background: color,
              opacity: reached ? 1 : 0.35,
              boxShadow: current ? `0 0 0 3px #050810, 0 0 12px ${color}` : "0 0 0 2px #050810",
            }}
          />
        );
      })}
    </div>
  );
}

function EndCard({ manifest, opacity }: { manifest: VideoManifest; opacity: number }) {
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 520,
          background: "linear-gradient(to top, rgba(5,8,16,0.96) 30%, rgba(5,8,16,0) 100%)",
        }}
      />
      <div style={{ position: "absolute", left: 72, right: 72, bottom: 80 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.32em", color: "#7dd3fc" }}>
          END OF RECORD
        </div>
        <h2 style={{ margin: "12px 0 0", maxWidth: 1000, fontSize: 48, lineHeight: 1.1, color: "white" }}>
          {manifest.title}
        </h2>
        <p style={{ margin: "14px 0 0", fontSize: 18, color: "#94a3b8" }}>
          {manifest.eventCount} sourced events · {formatRange(manifest.startAt, manifest.endAt)}
          {manifest.status === "ongoing" ? " · still unfolding" : ""}
        </p>
        {manifest.epilogue ? (
          <p style={{ margin: "16px 0 0", maxWidth: 900, fontSize: 22, lineHeight: 1.4, fontStyle: "italic", color: "#e2e8f0" }}>
            {manifest.epilogue}
          </p>
        ) : null}
        {manifest.relatedStories.length > 0 ? (
          <div style={{ marginTop: 22, display: "flex", flexWrap: "wrap", gap: 10 }}>
            {manifest.relatedStories.slice(0, 3).map((story) => (
              <div
                key={story.slug}
                style={{
                  maxWidth: 360,
                  borderRadius: 10,
                  border: "1px dashed #334155",
                  background: "rgba(15,23,42,0.72)",
                  padding: "10px 14px",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 650, color: "#e2e8f0" }}>{story.title}</div>
                <div style={{ marginTop: 3, fontSize: 13, color: "#94a3b8" }}>{story.relation}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

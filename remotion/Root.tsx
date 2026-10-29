import React from "react";
import { Composition, staticFile, type CalculateMetadataFunction } from "remotion";
import { StoryVideo, type StoryVideoProps } from "./StoryVideo";
import { FPS, type VideoManifest } from "./types";

/**
 * Every story is authored twice: 1920×1080 for desktop and 1080×1920 for
 * mobile. StoryVideo reads the composition size and rearranges itself
 * (right-side panel vs bottom sheet), so both render from the same component.
 *
 * Compositions are registered once, not per story: the slug to render arrives
 * as input props (`--props` on the CLI), and the staged manifest under
 * public/remotion/<slug>/ shapes duration and props. Nothing is hardcoded —
 * stories come from the database at render time.
 */
const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

async function metadataFor(props: StoryVideoProps, size: typeof LANDSCAPE, suffix: string) {
  const response = await fetch(staticFile(`remotion/${props.slug}/manifest.json`));
  if (!response.ok) {
    throw new Error(
      `No staged video for "${props.slug}". Run \`npm run render:story -- ${props.slug}\` first.`
    );
  }
  const manifest = (await response.json()) as VideoManifest;
  return {
    durationInFrames: manifest.durationInFrames,
    fps: FPS,
    ...size,
    props: { slug: props.slug, manifest },
    defaultOutName: `neoflix-${props.slug}${suffix}`,
  };
}

const calculateLandscape: CalculateMetadataFunction<StoryVideoProps> = ({ props }) =>
  metadataFor(props, LANDSCAPE, "");

const calculatePortrait: CalculateMetadataFunction<StoryVideoProps> = ({ props }) =>
  metadataFor(props, PORTRAIT, "-vertical");

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="story"
        component={StoryVideo}
        durationInFrames={FPS * 10}
        fps={FPS}
        width={LANDSCAPE.width}
        height={LANDSCAPE.height}
        defaultProps={{ slug: "story", manifest: null }}
        calculateMetadata={calculateLandscape}
      />
      <Composition
        id="story-vertical"
        component={StoryVideo}
        durationInFrames={FPS * 10}
        fps={FPS}
        width={PORTRAIT.width}
        height={PORTRAIT.height}
        defaultProps={{ slug: "story", manifest: null }}
        calculateMetadata={calculatePortrait}
      />
    </>
  );
};

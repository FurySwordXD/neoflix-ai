import React from "react";
import { Composition, staticFile, type CalculateMetadataFunction } from "remotion";
import { STORY_SLUGS } from "./catalog";
import { StoryVideo, type StoryVideoProps } from "./StoryVideo";
import { FPS, type VideoManifest } from "./types";

/**
 * Every story is authored twice: 1920×1080 for desktop and 1080×1920 for
 * mobile. StoryVideo reads the composition size and rearranges itself
 * (right-side panel vs bottom sheet), so both render from the same component.
 */
const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

const calculateLandscape: CalculateMetadataFunction<StoryVideoProps> = async ({ props }) => {
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
    ...LANDSCAPE,
    props: { slug: props.slug, manifest },
    defaultOutName: `neoflix-${props.slug}`,
  };
};

const calculatePortrait: CalculateMetadataFunction<StoryVideoProps> = async ({ props }) => {
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
    ...PORTRAIT,
    props: { slug: props.slug, manifest },
    defaultOutName: `neoflix-${props.slug}-vertical`,
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {STORY_SLUGS.map((slug) => (
        <Composition
          key={slug}
          id={slug}
          component={StoryVideo}
          durationInFrames={FPS * 10}
          fps={FPS}
          width={LANDSCAPE.width}
          height={LANDSCAPE.height}
          defaultProps={{ slug, manifest: null }}
          calculateMetadata={calculateLandscape}
        />
      ))}
      {STORY_SLUGS.map((slug) => (
        <Composition
          key={`${slug}-vertical`}
          id={`${slug}-vertical`}
          component={StoryVideo}
          durationInFrames={FPS * 10}
          fps={FPS}
          width={PORTRAIT.width}
          height={PORTRAIT.height}
          defaultProps={{ slug, manifest: null }}
          calculateMetadata={calculatePortrait}
        />
      ))}
    </>
  );
};

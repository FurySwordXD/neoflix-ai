import React from "react";
import { Composition, staticFile, type CalculateMetadataFunction } from "remotion";
import { STORY_SLUGS } from "./catalog";
import { StoryVideo, type StoryVideoProps } from "./StoryVideo";
import { FPS, type VideoManifest } from "./types";

const calculateMetadata: CalculateMetadataFunction<StoryVideoProps> = async ({ props }) => {
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
    width: 1920,
    height: 1080,
    props: { slug: props.slug, manifest },
    defaultOutName: `worldnews-${props.slug}`,
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
          width={1920}
          height={1080}
          defaultProps={{ slug, manifest: null }}
          calculateMetadata={calculateMetadata}
        />
      ))}
    </>
  );
};

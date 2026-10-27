import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "react-globe.gl",
    "three-globe",
    "remotion",
    "@remotion/player",
    "@remotion/web-renderer",
    "@remotion/media",
    "@remotion/three",
    "@react-three/fiber",
  ],
};

export default nextConfig;

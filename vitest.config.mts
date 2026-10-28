import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors the "@/*" path alias in tsconfig.json.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      include: [
        "src/lib/storyStore/**",
        "src/lib/stories.ts",
        "src/lib/graphResearch.ts",
        "src/lib/trendSync/**",
        "src/lib/trends.ts",
        "src/lib/trendRegions.ts",
      ],
      reporter: ["text", "html"],
    },
  },
});

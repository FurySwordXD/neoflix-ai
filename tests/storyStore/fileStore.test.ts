import fs from "fs";
import os from "os";
import path from "path";
import { afterAll } from "vitest";
import { createFileStore } from "@/lib/storyStore/fileStore";
import { runStoreContract } from "./contract";

const tempDirs: string[] = [];

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "algonews-stories-"));
  tempDirs.push(dir);
  return createFileStore(dir);
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

runStoreContract("file", () => ({
  fresh: async () => tempStore(),
  freshSource: async () => tempStore(),
}));

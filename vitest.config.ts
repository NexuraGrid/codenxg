import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Transforming Monaco dominates the run on /mnt/c; keep it between runs.
    fsModuleCache: true,
    environment: "jsdom",
    css: false,
    setupFiles: ["src/test-setup.ts"],
  },
});

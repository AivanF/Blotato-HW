import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Setup and cleanup that hang, such as closing a pool with a stuck connection, fail instead.
    hookTimeout: 30_000,
    teardownTimeout: 15_000,
  },
});

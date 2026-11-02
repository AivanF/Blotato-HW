import {
  createMemoryRateLimiter,
  createMemoryStore,
  describeRateLimiter,
  describeRunStore,
} from "../src/index.ts";

describeRunStore("memory", async () => createMemoryStore());
describeRateLimiter("memory", async () => createMemoryRateLimiter());

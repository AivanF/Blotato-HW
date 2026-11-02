import { createMemoryStore, describeRunStore } from "../src/index.ts";

describeRunStore("memory", async () => createMemoryStore());

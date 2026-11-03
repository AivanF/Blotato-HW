import { describeRateLimiter, describeRunStore } from "@automations/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresRateLimiter, createPostgresStore, migrate } from "../src/index.ts";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "./support.ts";

describe.skipIf(TEST_DATABASE_URL === undefined)("Postgres adapters", () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await createTestDatabase(TEST_DATABASE_URL as string);
  });

  // Skipped when setup failed, so its error isn't buried under a second one.
  afterAll(async () => {
    await database?.dispose();
  });

  describeRunStore("postgres", async () => {
    await database?.reset();
    return createPostgresStore((database as TestDatabase).pool);
  });

  describeRateLimiter("postgres", async () => {
    await database?.reset();
    return createPostgresRateLimiter((database as TestDatabase).pool);
  });

  it("applies migrations only once, even when servers start together", async () => {
    await Promise.all(Array.from({ length: 8 }, () => migrate((database as TestDatabase).pool)));
    const { rows } = await (database as TestDatabase).pool.query("SELECT name FROM schema_migrations");
    expect(rows).toEqual([{ name: "001_initial.sql" }]);
  });
});

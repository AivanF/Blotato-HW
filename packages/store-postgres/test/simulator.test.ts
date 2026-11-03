import { arbFaultySchedule, arbHealthySchedule, runSchedule } from "@automations/testkit";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresRateLimiter, createPostgresStore } from "../src/index.ts";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "./support.ts";

const RUNS = Number(process.env["SIMULATOR_RUNS"] ?? 15);
const TIMEOUT = 280_000;

describe.skipIf(TEST_DATABASE_URL === undefined)("the system on Postgres", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(TEST_DATABASE_URL as string);
  });

  afterAll(async () => {
    await database.dispose();
  });

  const onPostgres = async () => {
    await database.reset();
    return {
      store: createPostgresStore(database.pool),
      limiter: createPostgresRateLimiter(database.pool),
    };
  };

  it(
    "keeps every guarantee through crashes, faults and real parallel workers",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbFaultySchedule, async (actions) => {
          await runSchedule(actions, await onPostgres());
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    "sends each message exactly once when nothing goes wrong",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbHealthySchedule, async (actions) => {
          const simulation = await runSchedule(actions, await onPostgres());
          const keys = simulation.harness.gateway.sent.map((message) => message.key);
          expect(new Set(keys).size).toBe(keys.length);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

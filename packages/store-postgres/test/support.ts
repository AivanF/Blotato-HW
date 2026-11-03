import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPool, migrate } from "../src/index.ts";

/** A dedicated variable, so these tests can never point at a real database by accident. */
export const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

export type TestDatabase = {
  readonly pool: pg.Pool;
  /** Empties every table, restarting the sequences. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
};

/** Each test file gets its own schema, so files can run in parallel. */
export const createTestDatabase = async (url: string): Promise<TestDatabase> => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const pool = createPool({
    connectionString: url,
    options: `-c search_path=${schema}`,
    max: 24,
  });
  await migrate(pool);

  return {
    pool,
    reset: async () => {
      await pool.query(
        `TRUNCATE inbound_events, runs, run_transitions, effects, contacts, rate_limit_log
         RESTART IDENTITY CASCADE`,
      );
    },
    dispose: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
};

import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export type Client = pg.ClientBase;

/**
 * A pool that fails fast: a stuck lock, query or connection raises an error instead of
 * waiting forever, so a worker gives up its lease and another one retries.
 */
export const createPool = (config: pg.PoolConfig): pg.Pool =>
  new pg.Pool({
    connectionTimeoutMillis: 5_000,
    lock_timeout: 5_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 10_000,
    ...config,
  });

/** Rolls back if `work` throws, so a failed transition leaves nothing behind. */
export const inTransaction = async <T>(
  pool: pg.Pool,
  work: (client: Client) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    throw error;
  } finally {
    // Passing an error makes the pool discard a connection that may be in a bad state.
    client.release(broken);
  }
};

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const MIGRATION_LOCK = 727_001;

/** Applies new migrations in name order. Safe when several servers start at once. */
export const migrate = async (pool: pg.Pool): Promise<void> => {
  const names = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  await inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
    for (const name of names) {
      const { rowCount } = await client.query(
        "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
        [name],
      );
      if (rowCount === 1) {
        await client.query(await readFile(new URL(name, MIGRATIONS), "utf8"));
      }
    }
  });
};

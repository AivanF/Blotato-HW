import type { RateLimiter } from "@automations/core";
import type pg from "pg";
import { inTransaction } from "./database.ts";

/** An advisory lock per limit serializes workers, so a burst can't slip past the count. */
export const createPostgresRateLimiter = (pool: pg.Pool): RateLimiter => ({
  async acquire(account, limit, now) {
    const key = JSON.stringify([account.platform, account.accountId, limit.action, limit.perMs]);
    return inTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      await client.query("DELETE FROM rate_limit_log WHERE key = $1 AND at <= $2", [
        key,
        now - limit.perMs,
      ]);
      const { rows } = await client.query<{ count: string; oldest: string | null }>(
        "SELECT count(*) AS count, min(at) AS oldest FROM rate_limit_log WHERE key = $1",
        [key],
      );
      const count = Number(rows[0]?.count ?? 0);
      if (count >= limit.max && rows[0]?.oldest != null) {
        return { tag: "denied", retryAt: Number(rows[0].oldest) + limit.perMs };
      }
      await client.query("INSERT INTO rate_limit_log (key, at) VALUES ($1, $2)", [key, now]);
      return { tag: "granted" };
    });
  },
});

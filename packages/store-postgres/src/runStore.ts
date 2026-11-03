import {
  eventContact,
  initialState,
  platformId,
  wakeAt,
  type ClaimedEffect,
  type ContactPatch,
  type Effect,
  type EffectStatus,
  type InboundEvent,
  type Input,
  type RunRef,
  type RunState,
  type RunStore,
  type TransitionFn,
} from "@automations/core";
import type pg from "pg";
import { inTransaction, type Client } from "./database.ts";

type RunRow = {
  run_id: string;
  version_id: string;
  platform: string;
  account_id: string;
  contact_id: string;
};

const refOf = (row: RunRow): RunRef => ({
  runId: row.run_id,
  versionId: row.version_id,
  account: { platform: platformId(row.platform), accountId: row.account_id },
  contactId: row.contact_id,
});

const isFailed = (state: RunState): boolean => state.tag === "done" && state.outcome === "failed";

const saveContact = async (client: Client, run: RunRef, patch: ContactPatch): Promise<void> => {
  await client.query(
    `INSERT INTO contacts (platform, account_id, contact_id, nickname, email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (platform, account_id, contact_id) DO UPDATE SET
       nickname = COALESCE(EXCLUDED.nickname, contacts.nickname),
       email = COALESCE(EXCLUDED.email, contacts.email)`,
    [
      run.account.platform,
      run.account.accountId,
      run.contactId,
      patch.nickname ?? null,
      patch.email ?? null,
    ],
  );
};

/** Commits one transition. The caller must hold the run's row lock. */
const applyTransition = async (
  client: Client,
  run: RunRef,
  state: RunState,
  input: Input,
  f: TransitionFn,
): Promise<void> => {
  const transition = f(state, input);
  await client.query(
    `INSERT INTO run_transitions (run_id, input_id, input, effects, contact, state)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb)`,
    [
      run.runId,
      input.id,
      JSON.stringify(input),
      JSON.stringify(transition.effects),
      transition.contact === undefined ? null : JSON.stringify(transition.contact),
      JSON.stringify(transition.state),
    ],
  );
  await client.query("UPDATE runs SET state = $2::jsonb, active = $3, wake_at = $4 WHERE run_id = $1", [
    run.runId,
    JSON.stringify(transition.state),
    transition.state.tag !== "done",
    wakeAt(transition.state),
  ]);
  if (transition.contact !== undefined) {
    await saveContact(client, run, transition.contact);
  }
  for (const effect of transition.effects) {
    await client.query(
      `INSERT INTO effects (run_id, seq, effect, status) VALUES ($1, $2, $3::jsonb, 'queued')`,
      [run.runId, effect.seq, JSON.stringify(effect)],
    );
  }
  if (isFailed(transition.state)) {
    await client.query(`UPDATE effects SET status = 'cancelled' WHERE run_id = $1 AND status = 'queued'`, [
      run.runId,
    ]);
  }
};

/** Lock order is always the run first, so transitions on one run can't deadlock. */
const lockRun = async (
  client: Client,
  runId: string,
): Promise<{ ref: RunRef; state: RunState } | null> => {
  const { rows } = await client.query<RunRow & { state: RunState }>(
    "SELECT * FROM runs WHERE run_id = $1 FOR UPDATE",
    [runId],
  );
  const row = rows[0];
  return row === undefined ? null : { ref: refOf(row), state: row.state };
};

const applyOnce = async (
  client: Client,
  run: { ref: RunRef; state: RunState },
  input: Input,
  f: TransitionFn,
): Promise<"applied" | "duplicate"> => {
  const { rowCount } = await client.query(
    "SELECT 1 FROM run_transitions WHERE run_id = $1 AND input_id = $2",
    [run.ref.runId, input.id],
  );
  if (rowCount !== 0) {
    return "duplicate";
  }
  await applyTransition(client, run.ref, run.state, input, f);
  return "applied";
};

/**
 * Each guarantee of the port rests on a specific Postgres feature: unique indexes for
 * deduplication and the one-active-run rule, `FOR UPDATE` to serialize a run's transitions, and
 * `SKIP LOCKED` so claims never block or double-claim. Leases are re-checked on the locked row,
 * because READ COMMITTED re-evaluates the WHERE clause after a row changes.
 */
export const createPostgresStore = (pool: pg.Pool): RunStore => ({
  async appendEvents(events) {
    await inTransaction(pool, async (client) => {
      for (const event of events) {
        await client.query(
          `INSERT INTO inbound_events (platform, account_id, event_id, contact_id, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            event.platform,
            event.accountId,
            event.eventId,
            eventContact(event),
            JSON.stringify(event),
          ],
        );
      }
    });
  },

  async claimEvent(now, leaseMs) {
    const { rows } = await pool.query<{ payload: InboundEvent }>(
      `WITH heads AS (
         SELECT DISTINCT ON (platform, account_id, contact_id) seq
         FROM inbound_events
         WHERE NOT processed
         ORDER BY platform, account_id, contact_id, seq
       ),
       picked AS (
         SELECT seq FROM inbound_events
         WHERE seq IN (SELECT seq FROM heads)
           AND NOT processed
           AND (lease_until IS NULL OR lease_until <= $1)
         ORDER BY seq
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE inbound_events SET lease_until = $2
       WHERE seq IN (SELECT seq FROM picked)
       RETURNING payload`,
      [now, now + leaseMs],
    );
    return rows[0]?.payload ?? null;
  },

  async completeEvent(ref) {
    await pool.query(
      `UPDATE inbound_events SET processed = true, lease_until = NULL
       WHERE platform = $1 AND account_id = $2 AND event_id = $3`,
      [ref.platform, ref.accountId, ref.eventId],
    );
  },

  async startRun(run, input, f) {
    return inTransaction(pool, async (client) => {
      // Waits for any in-flight conflicting insert, then conflicts on the run id or active slot.
      const { rowCount } = await client.query(
        `INSERT INTO runs (run_id, version_id, platform, account_id, contact_id, state, active)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, true)
         ON CONFLICT DO NOTHING`,
        [
          run.runId,
          run.versionId,
          run.account.platform,
          run.account.accountId,
          run.contactId,
          JSON.stringify(initialState),
        ],
      );
      if (rowCount === 0) {
        const existing = await client.query("SELECT 1 FROM runs WHERE run_id = $1", [run.runId]);
        return existing.rowCount === 0 ? "suppressed" : "duplicate";
      }
      await applyTransition(client, run, initialState, input, f);
      return "started";
    });
  },

  async applyInput(runId, input, f) {
    return inTransaction(pool, async (client) => {
      const run = await lockRun(client, runId);
      return run === null ? "unknownRun" : applyOnce(client, run, input, f);
    });
  },

  async findActiveRun(account, contactId) {
    const { rows } = await pool.query<RunRow>(
      `SELECT * FROM runs WHERE platform = $1 AND account_id = $2 AND contact_id = $3 AND active`,
      [account.platform, account.accountId, contactId],
    );
    return rows[0] === undefined ? null : refOf(rows[0]);
  },

  async dueRuns(now, limit) {
    const { rows } = await pool.query<RunRow & { wake_at: string }>(
      `SELECT * FROM runs WHERE active AND wake_at <= $1 ORDER BY wake_at LIMIT $2`,
      [now, limit],
    );
    return rows.map((row) => ({ run: refOf(row), wakeAt: Number(row.wake_at) }));
  },

  async getRun(runId) {
    const { rows } = await pool.query<RunRow & { state: RunState }>(
      "SELECT * FROM runs WHERE run_id = $1",
      [runId],
    );
    return rows[0] === undefined ? null : { ref: refOf(rows[0]), state: rows[0].state };
  },

  async transitions(runId) {
    const { rows } = await pool.query<{
      input: Input;
      effects: readonly Effect[];
      contact: ContactPatch | null;
      state: RunState;
    }>(
      "SELECT input, effects, contact, state FROM run_transitions WHERE run_id = $1 ORDER BY ordinal",
      [runId],
    );
    return rows.map(({ input, effects, contact, state }) =>
      contact === null ? { input, effects, state } : { input, effects, contact, state },
    );
  },

  async claimEffects(now, limit, leaseMs) {
    const { rows } = await pool.query<
      RunRow & { id: string; effect: Effect; attempts: number; failures: number; turn: string }
    >(
      `WITH heads AS (
         SELECT DISTINCT ON (run_id) id, run_id, next_attempt_at, lease_until
         FROM effects
         WHERE status = 'queued'
         ORDER BY run_id, seq
       ),
       ready AS (
         SELECT heads.id,
                row_number() OVER (PARTITION BY runs.platform, runs.account_id ORDER BY heads.id) AS turn
         FROM heads
         JOIN runs USING (run_id)
         WHERE (heads.next_attempt_at IS NULL OR heads.next_attempt_at <= $1)
           AND (heads.lease_until IS NULL OR heads.lease_until <= $1)
       ),
       picked AS (
         SELECT effects.id, ready.turn
         FROM effects
         JOIN ready USING (id)
         WHERE effects.status = 'queued'
           AND (effects.lease_until IS NULL OR effects.lease_until <= $1)
         ORDER BY ready.turn, effects.id
         LIMIT $2
         FOR UPDATE OF effects SKIP LOCKED
       ),
       claimed AS (
         UPDATE effects
         SET attempts = attempts + 1, lease_until = $3
         FROM picked
         WHERE effects.id = picked.id
         RETURNING effects.id, effects.run_id, effects.effect, effects.attempts, effects.failures, picked.turn
       )
       SELECT claimed.*, runs.version_id, runs.platform, runs.account_id, runs.contact_id
       FROM claimed
       JOIN runs USING (run_id)
       ORDER BY claimed.turn, claimed.id`,
      [now, limit, now + leaseMs],
    );
    return rows.map(
      (row): ClaimedEffect => ({
        run: refOf(row),
        effect: row.effect,
        attempt: row.attempts,
        failures: row.failures,
      }),
    );
  },

  async retryEffect(ref, attempt, retryAt, error) {
    await pool.query(
      `UPDATE effects
       SET next_attempt_at = $4, lease_until = NULL, failures = failures + 1, last_error = $5
       WHERE run_id = $1 AND seq = $2 AND attempts = $3 AND status = 'queued'`,
      [ref.runId, ref.seq, attempt, retryAt, error],
    );
  },

  async deferEffect(ref, attempt, retryAt) {
    await pool.query(
      `UPDATE effects
       SET next_attempt_at = $4, lease_until = NULL
       WHERE run_id = $1 AND seq = $2 AND attempts = $3 AND status = 'queued'`,
      [ref.runId, ref.seq, attempt, retryAt],
    );
  },

  async finishEffect(ref, result, input, f) {
    await inTransaction(pool, async (client) => {
      const run = await lockRun(client, ref.runId);
      if (run === null) {
        return;
      }
      const { rowCount } = await client.query(
        "SELECT 1 FROM effects WHERE run_id = $1 AND seq = $2",
        [ref.runId, ref.seq],
      );
      if (rowCount === 0) {
        return;
      }
      await applyOnce(client, run, input, f);
      await client.query(
        `UPDATE effects
         SET status = $3, lease_until = NULL, last_error = COALESCE($4, last_error)
         WHERE run_id = $1 AND seq = $2 AND status IN ('queued', 'cancelled')`,
        [ref.runId, ref.seq, result.tag, result.tag === "failed" ? result.error : null],
      );
    });
  },

  async effects(runId) {
    const { rows } = await pool.query<{
      effect: Effect;
      status: EffectStatus;
      attempts: number;
      failures: number;
      last_error: string | null;
    }>("SELECT effect, status, attempts, failures, last_error FROM effects WHERE run_id = $1 ORDER BY seq", [
      runId,
    ]);
    return rows.map(({ effect, status, attempts, failures, last_error }) => ({
      effect,
      status,
      attempts,
      failures,
      lastError: last_error,
    }));
  },

  async getContact(account, contactId) {
    const { rows } = await pool.query<{ nickname: string | null; email: string | null }>(
      `SELECT nickname, email FROM contacts
       WHERE platform = $1 AND account_id = $2 AND contact_id = $3`,
      [account.platform, account.accountId, contactId],
    );
    return rows[0] === undefined
      ? null
      : { account, contactId, nickname: rows[0].nickname, email: rows[0].email };
  },
});

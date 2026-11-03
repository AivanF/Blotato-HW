-- Times are epoch milliseconds passed in by the caller, so the engine's clock stays the only clock.

CREATE TABLE inbound_events (
  seq         bigserial UNIQUE,
  platform    text NOT NULL,
  account_id  text NOT NULL,
  event_id    text NOT NULL,
  contact_id  text NOT NULL,
  payload     jsonb NOT NULL,
  processed   boolean NOT NULL DEFAULT false,
  lease_until bigint,
  PRIMARY KEY (platform, account_id, event_id)
);

-- Finds the oldest unprocessed event of each contact.
CREATE INDEX inbound_events_contact_heads
  ON inbound_events (platform, account_id, contact_id, seq)
  WHERE NOT processed;

CREATE TABLE runs (
  run_id     text PRIMARY KEY,
  version_id text NOT NULL,
  platform   text NOT NULL,
  account_id text NOT NULL,
  contact_id text NOT NULL,
  state      jsonb NOT NULL,
  active     boolean NOT NULL,
  wake_at    bigint
);

-- At most one active run per contact, so every DM reply has exactly one addressee.
CREATE UNIQUE INDEX runs_one_active_per_contact
  ON runs (platform, account_id, contact_id)
  WHERE active;

CREATE INDEX runs_due_timers
  ON runs (wake_at)
  WHERE active AND wake_at IS NOT NULL;

CREATE TABLE run_transitions (
  ordinal  bigserial UNIQUE,
  run_id   text NOT NULL REFERENCES runs (run_id),
  input_id text NOT NULL,
  input    jsonb NOT NULL,
  effects  jsonb NOT NULL,
  contact  jsonb,
  state    jsonb NOT NULL,
  PRIMARY KEY (run_id, input_id)
);

CREATE TABLE effects (
  id              bigserial UNIQUE,
  run_id          text NOT NULL REFERENCES runs (run_id),
  seq             integer NOT NULL,
  effect          jsonb NOT NULL,
  status          text NOT NULL CHECK (status IN ('queued', 'delivered', 'failed', 'cancelled')),
  attempts        integer NOT NULL DEFAULT 0,
  failures        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at bigint,
  lease_until     bigint,
  PRIMARY KEY (run_id, seq)
);

-- Finds the earliest unfinished effect of each run.
CREATE INDEX effects_run_heads
  ON effects (run_id, seq)
  WHERE status = 'queued';

CREATE TABLE contacts (
  platform   text NOT NULL,
  account_id text NOT NULL,
  contact_id text NOT NULL,
  nickname   text,
  email      text,
  PRIMARY KEY (platform, account_id, contact_id)
);

CREATE TABLE rate_limit_log (
  key text NOT NULL,
  at  bigint NOT NULL
);

CREATE INDEX rate_limit_log_key_at ON rate_limit_log (key, at);

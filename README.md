# Comment Automations

A backend design for automations that start when someone comments on a social media post. For example:

> When someone comments "pricing" on any Instagram post, reply "Sent you a DM!", DM them asking for their email, wait for the answer, then DM them a link.

The system is built around one idea: **all run logic is a pure function, and everything that touches the world is a plug-in.**

## Status

| Part | Status |
|---|---|
| `packages/core`: state machine, validator, trigger matching | Built and tested |
| Ports in `packages/core` | Built |
| `packages/testkit`: memory store, store contract suite, contacts | Built and tested |
| Engine and `RateLimiter` in `packages/core` | Built and tested |
| Simulator in `packages/testkit` | Built |
| `packages/store-postgres`: store, rate limiter, migrations | Built and tested on real Postgres |
| Postgres service in Docker Compose | Built |
| HTTP transport, fake platform, full Compose stack | Designed |
| Postgres tables for automations (the `AutomationCatalog` port) | Designed |
| Mongo, gRPC, real Instagram and Facebook adapters | Designed for, not planned for this project |
| Write-up of AI use | To be written by the author |

Everything below marked "Designed" describes the plan, not working code.

## The core idea

A durable workflow has to survive for days, across restarts. That rules out holding its next step in a closure, because a closure can't be stored in a database. Turning that closure into data gives a **Mealy machine**:

```ts
const { state, effects } = step(config, state, input);
```

- `step` reads no clock or database and sends nothing. It returns the next state and a list of effects to perform.
- The caller saves the state and effects together in one transaction, and sends the effects afterwards.

This has one especially useful consequence: the run is already waiting for a reply before the DM asking for it goes out. A very fast reply can't arrive too early.

### Where the math helps

| Math | In the system | What it gives us |
|---|---|---|
| Kleisli endomorphisms of `Writer<Effect[]>` on `S` | `step` | A pure core, tested without mocks |
| Free monoid action of `Input*` | `replay`, a fold over inputs | A replayable audit log |
| Defunctionalization | Nodes and extractors as JSON tags | Definitions that can be stored |
| Natural transformation `Effect ~> Task` | `sendEffects` and `PlatformGateway` | Swappable platform adapters |
| `Event → Option<Binding>` under the `First` monoid | `selectAutomation` | Deterministic priority |
| Dataflow over a semilattice | `forwardFlow` in the validator | Proof that variables are bound and policies are met |
| Algebraic theory and its models | `RunStore` and its adapters | One contract suite checks every database |

The math stops at the network. Exactly-once sending is impossible, so section "Reliability" makes a deliberate choice instead.

## Architecture

```
HTTP webhook ─┐
              ├─ InboundEvent → inbox (dedupe) → Dispatcher ─ matches trigger / routes reply
gRPC ─────────┘                                      │
                                 one atomic write: state + log + effects
                                                     │
Timer sweeper (wake_at) → Dispatcher                 ▼
                                               effects outbox → Effect worker → PlatformGateway
                                                     ▲               │
                                                     └ EffectSettled ┘
```

The core is agnostic along three separate axes:

| Axis | Port | How it stays agnostic |
|---|---|---|
| Database | `RunStore` | The port promises guarantees in domain terms, with no generic `transaction()` |
| Social platform | `PlatformPolicy`, `PlatformGateway` | Rules are data, and `PlatformId` is an opaque string the core never branches on |
| Transport | One `InboundEvent` type | Every source converges on it, giving N+M adapters rather than N×M |

## The example flow

| State | Input | Next state | Effects |
|---|---|---|---|
| Idle | `Started` | Waiting | Reply to comment, then DM asking for email |
| Waiting | Reply contains an email | Completed | DM with the link |
| Waiting | Reply has no email, re-prompts left | Waiting | Re-prompt DM |
| Waiting | Reply has no email, none left | Abandoned | None |
| Waiting | `TimerFired` | Expired | None |
| Waiting | Ask DM failed for good | Failed | None |

## Decisions

### Product decisions

These are product questions rather than system design ones. This is a test project, so they're decided here and easy to change later.

| Question | Decision | Why | Status |
|---|---|---|---|
| Can someone trigger an automation again after their run ends? | Yes, with no cooldown | It's simple, and they asked again | Built |
| What if they trigger it again during an active run? | No new run; the event is logged as suppressed | Prevents duplicate DMs | Built |
| What if a second automation matches during an active run? | Same: suppressed and logged | A DM reply must have exactly one addressee, or an email could reach the wrong flow | Built |
| What if a rate-limit backlog delays the DM? | "Sent you a DM!" can go out well before the DM does. A customer can avoid this by putting the DM step first | Holding replies back would need effects to reserve limits together, which isn't worth the complexity yet | Built |
| What if several automations match one comment? | Only the highest priority runs | Two automations messaging one person is spam | Built |
| What counts as a keyword match? | Case-insensitive whole word: "Pricing?" matches, "repricing" doesn't | Fewest false triggers | Built |
| Do the account's own comments trigger anything? | No | Our own reply could otherwise retrigger the automation forever | Built |
| What counts as an email? | The first email-shaped text in a reply, with no deliverability check | People write "sure, it's a@b.co thanks" | Built |
| What if the reply isn't an email? | Re-prompt up to a per-automation limit, then abandon | Gives people a chance without nagging | Built |
| What if they never reply? | The run expires silently after a per-automation timeout | Platform rules forbid reminders on Instagram | Built |
| What if the comment reply fails? | Carry on | The DM is what matters | Built |
| What if the final link DM fails? | The run stays Completed, and the failure raises an `effectFailed` note for alerting | The email is already captured | Built |
| What happens to in-flight runs when an automation is edited? | They finish on the version they started with | Changing a flow mid-conversation could strand a run | Built |
| Is one person on two platforms one contact? | No, they're two contacts | Matching them would be guesswork with PII | Built |
| What do we store about a contact? | Social platform, user ID, nickname if the platform gives one, and email | It's what a customer needs for a lead list | Built |
| What if a contact gives a different email later? | The latest one replaces it | It's the address they most recently chose to give | Built |

### Engineering decisions

| Decision | Why |
|---|---|
| A graph of four node types, not a fixed pipeline or general DSL | Handling an invalid reply already needs a branch, and nothing needs more yet |
| Postgres with our own state machine, not Temporal | Customer-authored flows would still need this interpreter inside a workflow, plus a cluster to run. `step` could move to Temporal unchanged |
| A failed run cancels its queued effects | A contact should never get messages from a dead flow. Enforced by the store contract; a completed run's final DM is unaffected |
| An effect's result and its run update are one atomic write | With two writes, a crash between them leaves a run waiting on an effect it can never hear about |
| A run's ID is derived from its trigger event | Retrying that event can't create a second run, so no separate uniqueness check is needed |
| Contact changes are an output of `step`, saved in the run's write | A crash can't lose a captured email or record one twice, and the logic stays pure |
| A `RateLimiter` port checked by the effect worker, with limits in `PlatformPolicy` | Keeps the store simple to implement, while limits stay per-platform data |
| A sliding log for rate limits, not a token bucket | A token bucket can allow twice the limit within one window |
| Waiting for a rate limit doesn't count as a failed send | Otherwise a backlog alone would make effects give up |
| The engine is single steps with no loops inside | A server and a simulator can each schedule them their own way |
| State column as source of truth, plus a transition log | Simpler reads than full event sourcing. A test asserts that folding the log gives the state |
| Timeouts start at delivery, not when queued | A long rate-limit backlog would otherwise use up the wait |
| Plain discriminated unions, no fp-ts or Effect | The math stays in the design, and the code stays easy to read |

## Platform constraints

Instagram's rules shaped the design, and they're expressed as a `PlatformPolicy` value:

- **One private reply:** a commenter can get one DM, within 7 days of the comment, addressed by comment ID.
- **Follow-up window:** further DMs need the user to respond first, and must go out within 24 hours of that response.
- **Rate limit:** third-party guides report 750 private replies per hour per account. At that rate, 10,000 matching comments take about 13 hours to clear. This figure still needs checking against Meta's rate-limit page.

One assumption needs checking against the real integration: that a commenter's ID in comment webhooks equals their sender ID in DM webhooks. Reply routing depends on it.

Source: [Meta: Private Replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies.md)

## Reliability

Each row is a guarantee of the store port, checked by the same contract suite on the memory store and on real Postgres. The Postgres column is how that adapter provides it. Rate limiting is a separate port with its own contract, and uses an advisory lock per limit.

| Hazard | Guarantee | Postgres |
|---|---|---|
| Duplicate webhooks | Each event is applied once | Unique `(platform, account_id, event_id)` |
| Same input delivered twice | Each input is applied once per run | Unique `(run_id, input_id)` |
| Two workers on one run | Transitions are serialized per run | `SELECT … FOR UPDATE` |
| Crash mid-transition | State, log and effects commit together | Transaction |
| Messages out of order | One event at a time per contact, oldest first | `SKIP LOCKED` |
| Double-triggered contact | One active run per account and contact | Partial unique index |
| Crash between send and mark-sent | At-least-once delivery | Leases on claimed effects |
| Viral post | One customer can't starve the others | Per-account rate limits and fair claiming |

Delivery is at-least-once, so a crash can occasionally produce a duplicate DM. A rare duplicate is a better failure than a lost lead.

## Data model

The first three tables are designed, not built: for now, automations come from whatever implements the `AutomationCatalog` port. The rest are in `packages/store-postgres/migrations`.

| Table | Purpose | Key constraints |
|---|---|---|
| `automations` | Status, priority, active version | |
| `automation_accounts` | Which accounts an automation targets | Unique `(automation_id, social_account_id)` |
| `automation_versions` | Immutable `definition` JSON | Unique `(automation_id, version)` |
| `rate_limit_log` | Recent sends per limit | Indexed `(key, at)` |
| `contacts` | Platform, account, user ID, nickname and email (PII) | Unique `(platform, account_id, contact_id)` |
| `inbound_events` | Inbox | Unique `(platform, account_id, event_id)` |
| `runs` | `state` JSON, `active`, `wake_at`, pinned version | Primary key derived from the trigger event; partial unique `(platform, account_id, contact_id) WHERE active` |
| `run_transitions` | Audit log: input, effects, state after | Unique `(run_id, input_id)` |
| `effects` | Outbox: `effect` JSON, `status`, `attempts`, `failures`, `next_attempt_at`, `lease_until` | Unique `(run_id, seq)` |

## The core package

`packages/core` has no runtime dependencies and does no I/O.

| File | Responsibility |
|---|---|
| `definition.ts` | Flow graph types: triggers, nodes, `ValidDefinition` |
| `machine.ts` | `step`, `replay`, `wakeAt` and the run state types |
| `validate.ts` | `validate`, the only way to get a `ValidDefinition` |
| `trigger.ts` | Keyword matching and `selectAutomation` |
| `extract.ts` | Pulls a value such as an email out of free text |
| `render.ts` | Fills `{{variable}}` templates, in a single pass |
| `platform.ts` | `PlatformId` and `PlatformPolicy` |
| `events.ts` | `InboundEvent`, the canonical form of everything received |
| `ports.ts` | `RunStore`, `PlatformGateway`, `RateLimiter` and the other interfaces adapters implement |
| `engine/dispatcher.ts` | `dispatchNext`: turns one inbound event into a new run or a reply |
| `engine/effectWorker.ts` | `sendEffects`: deadlines, rate limits, sends, retries and backoff |
| `engine/timerSweeper.ts` | `fireTimers`: delivers due timeouts to their runs |

### Usage

```ts
import { initialState, platformId, step, validate, wakeAt } from "@automations/core";

const policy = {
  rateLimits: [{ action: "privateReply", max: 750, perMs: 3_600_000 }],
  dmFromComment: { maxMessages: 1, withinMs: 7 * 24 * 3_600_000 },
  followUpWindowMs: 24 * 3_600_000,
};

const result = validate(definition, [{ platform: platformId("instagram"), policy }]);
if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));

const config = { definition: result.definition, policy };
const { state, effects } = step(config, initialState, {
  tag: "Started",
  id: "event-1",
  at: Date.now(),
  comment,
});

// Save state and effects atomically, send the effects, and feed the results back as inputs.
const nextTimer = wakeAt(state);
```

See `pricingFlow` in `packages/core/test/fixtures.ts` for a full definition.

### What validation guarantees

`step` only accepts a `ValidDefinition`. A definition passes only if:

- the entry and all edges exist, and every node is reachable
- every cycle goes through an `awaitReply`, so a run can't send messages forever
- every `{{variable}}` is bound on every path to where it's used
- it obeys the policy of every platform it targets, and errors name the platform that fails

The policy check is deliberately strict: it can reject a legal flow, but it should never accept an illegal one. For example, it rejects a DM on a timeout path unless the contact has definitely replied and the window is still open.

### What the tests prove

| Law | Meaning |
|---|---|
| Totality | Any state accepts any input without throwing; an input with no meaning there changes nothing |
| Absorption | A finished run ignores everything |
| Monoid action | Resuming from a JSON snapshot equals one unbroken run |
| Redelivery | Duplicate inputs change nothing once deduplicated by id |
| Validator soundness | Any flow that passes obeys the platform policy under any inputs, and never shows an unfilled placeholder |

These run on generated flows and input sequences using fast-check, and cover the pure core only. The simulator below covers the engine and store together, and real database behaviour is for the Postgres contract run, which isn't built yet.

## The testkit package

`packages/testkit` holds what tests need to stand in for the outside world.

| File | Responsibility |
|---|---|
| `memoryStore.ts` | `createMemoryStore`, a `RunStore` for fast tests, with no database |
| `storeContract.ts` | `describeRunStore`, the tests every store adapter must pass |
| `rateLimiter.ts` | `createMemoryRateLimiter` and `describeRateLimiter`, the limiter's contract |
| `harness.ts` | The whole engine wired to in-memory parts, with a fake clock and fake gateway |
| `simulator.ts` | Runs the engine through adversarial schedules and checks the guarantees |

### What the simulator proves

A schedule is a generated list of: webhook deliveries in any order (with duplicates), engine steps (some run concurrently), clock jumps, crashes before or after any store write, and gateway failures. After each action, and after everything has drained, it checks:

| Guarantee | Meaning |
|---|---|
| One active run | A contact never has two unfinished runs |
| Rate limits | Sends never exceed a limit in any window |
| Platform rules | One private reply per comment, within its window; other DMs only within a day of a reply |
| Agreement with the fold | Each stored state and outbox equals `replay` of that run's log |
| Nothing stuck | Every run finishes, and no event or effect is left behind |
| No lost leads | A captured email gets its link, unless a fault was injected on that very send |
| Order | A run's messages go out in order |
| Exactly once when healthy | With no faults, each message goes out exactly once |

Crashes can still produce a duplicate message, by design. On the memory store, concurrency means interleaving at `await` points. The same schedules also run on Postgres, where workers really do run in parallel.

`RunStore` is split into three interfaces: `EventInbox`, `RunLog` and `EffectOutbox`. One adapter implements all three, because a single write can span them. It exposes no generic `transaction()`. Instead, each method is atomic and takes the pure transition as an argument, so an adapter can hold a lock or retry on a conflict.

To test a new adapter, pass a factory for a fresh store:

```ts
describeRunStore("postgres", async () => createPostgresStore(await freshDatabase()));
```

The memory store enforces the same constraints as a real database, but it's single-threaded. Its concurrency tests pass trivially, and only prove something on Postgres.

## The Postgres package

`packages/store-postgres` implements `RunStore` and `RateLimiter` with `pg` and plain SQL. It uses no ORM, because the guarantees depend on exact queries.

| File | Responsibility |
|---|---|
| `migrations/` | The schema, applied in name order by `migrate` |
| `src/runStore.ts` | `createPostgresStore` |
| `src/rateLimiter.ts` | `createPostgresRateLimiter` |
| `src/database.ts` | `migrate` and `inTransaction` |

Three details are easy to get wrong:

- **Claims re-check their conditions on the locked row.** `SKIP LOCKED` stops two workers locking one row at once, but a row can change between a query's snapshot and its lock. Without the re-check, an effect can be sent twice.
- **A run's transitions hold its row lock.** Every transition takes `FOR UPDATE` on the run first, which serializes them and gives a single lock order.
- **The JSON columns don't keep key order.** That's why state comparisons are structural, never on serialized strings.
- **Nothing waits forever.** `createPool` sets lock, statement, idle-transaction and connection timeouts. A stuck query then fails, and its lease expires so another worker retries.

The contract suite and simulator both run here too. Each test file gets its own schema, so these tests can run in parallel and can't touch other data.

## Development

Requires Node 24 or later and pnpm. Node runs the TypeScript directly, so there's no build step.

```sh
pnpm install
pnpm test       # fast tests only, no Docker needed
pnpm typecheck

pnpm db:up      # start Postgres in Docker, with its data in memory
pnpm test:db    # everything, including Postgres
pnpm db:down
```

`pnpm test` skips the Postgres tests when `TEST_DATABASE_URL` isn't set. `SIMULATOR_RUNS` sets how many schedules the Postgres simulator tries (default 15).

## Roadmap

1. `core`: machine, validator and property tests (done)
2. `testkit`: memory store and store contract suite (done)
3. `core`: engine (dispatcher, effect worker, timer sweeper) and rate limiter, plus a simulator that injects duplicates, reordering and crashes (done)
4. `store-postgres`, passing the same contract suite and simulator (done)
5. HTTP transport, fake platform and Docker Compose, with an end-to-end script that also kills the server mid-flow
6. Update this document to match what was actually built

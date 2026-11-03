# Comment Automations

A backend for automations that start when someone comments on a social media post, built as a design with a working, tested implementation. For example:

> When someone comments "pricing" on any Instagram post, reply "Sent you a DM!", DM them asking for their email, wait for the answer, then DM them a link.

The system is built around one idea: **all run logic is a pure function, and everything that touches the world is a plug-in.**

**Contents:** [1. Principles](#1-principles) · [2. Overview](#2-overview) · [3. Quick start](#3-quick-start) · [4. Repository layout](#4-repository-layout) · [5. Design](#5-design) · [6. Decisions](#6-decisions) · [7. Implementation](#7-implementation) · [8. Testing](#8-testing) · [9. Production considerations](#9-production-considerations) · [10. Known limitations](#10-known-limitations) · [11. Development](#11-development) · [12. AI usage](#12-ai-usage)

## 1. Principles

In general, I love and apply the following principles and priorities:
- Decomposition, Loose Coupling & High Cohesion
- Flexibility & extensibility
- Testability & TDD
- Maintainability
- YAGNI, KISS, DRY
- Security by design
- Business-oriented thinking

## 2. Overview

### 2.1. How the principles apply here

- **Automations are data, not code** _(decomposition, flexibility)_. Each automation is a versioned JSON definition: a trigger plus a graph of steps. Definitions live apart from the engine, so a new flow means new data, not new code. Today they're in a JSON file read at startup. With the designed database tables, a new flow wouldn't even need a restart. A running conversation stays on the version it started with.
- **One pure core, everything else a plug-in** _(loose coupling, extensibility)_. All run logic is a single pure function. Each outside dependency sits behind a port:
    - **the database:** Postgres, or an in-memory store for tests
    - **the social platform:** see the next point
    - **the transport:** HTTP webhooks now, gRPC later
- **Each social platform is a plug-in** _(decomposition, extensibility, business)_. The core never names a platform. A platform is three parts in its own package:
    - **a webhook codec:** turns the platform's webhooks into the common event format
    - **a gateway:** sends replies and DMs through the platform's API
    - **a policy:** its messaging windows, DM limits and rate limits, as data

  Adding Facebook or TikTok means writing those three parts, like `packages/platform-fake`, with no change to the core. Every flow is checked against its platform's policy before it goes live. The validator can already check one flow against several platforms at once, ready for automations that span accounts on different platforms.
- **Tested at every layer** _(testability)_. The pure core has property tests, and one contract suite checks every database adapter. A simulator throws crashes, duplicates and reordering at the whole engine, and an end-to-end test runs the Docker stack.
- **Only what's needed** _(YAGNI, KISS)_. There are four step types, no web framework and no ORM. Everything else is designed and written down, but not built.
- **Secure by default** _(security by design)_. Webhook signatures are checked on the raw bytes, definitions are parsed strictly, and only the contact data a lead list needs is stored.
- **Never lose a lead** _(business)_. A webhook is acknowledged only once it's stored, every step survives a crash, and messages are sent at least once.
- **Decisions are written down** _(maintainability)_. Product and engineering choices, with their reasons, are in section 6.

### 2.2. How it works

A customer sets up an automation: a trigger, such as a keyword in a comment, and a flow of steps. From then on:

1. **A webhook arrives.** The platform reports each new comment or DM. The server verifies its signature, stores it, and only then acknowledges it.
2. **A run starts.** The dispatcher matches a comment against the account's automations and starts a run for that person. A person has at most one active run at a time.
3. **The run moves step by step.** Each run is a small state machine. Every input (a comment, a reply, a timer, a delivery result) moves it to a new state and may queue messages to send.
4. **Messages go out.** Workers send queued messages through the platform, within its rate limits and messaging rules, and retry failures.
5. **Replies come back.** A person's DMs are routed to their active run, until it completes, gives up or expires.

Every step is one atomic write to Postgres, so after a crash a restarted worker picks up exactly where things stopped.

## 3. Quick start

Requires Node 24 or later, pnpm and Docker.

### 3.1. Run the tests

```sh
pnpm install
pnpm typecheck
pnpm test   # fast tests, no Docker needed, a few seconds
pnpm e2e    # the whole stack in Docker, with the server killed mid-flow, about a minute
```

More commands are in section 11, "Development".

### 3.2. Try the example by hand

Start the stack: the server, the fake platform and Postgres.

```sh
docker compose up -d --build --wait
```

Alice comments on a post, then answers the DM she gets:

```sh
curl -X POST http://localhost:8090/simulate/comment \
  -H 'Content-Type: application/json' \
  -d '{"account":"acme","from":"alice","fromName":"Alice","text":"Pricing?"}'

curl -X POST http://localhost:8090/simulate/message \
  -H 'Content-Type: application/json' \
  -d '{"account":"acme","from":"alice","text":"sure, alice@example.com"}'
```

Each call answers `{"eventId":"evt-1","serverStatus":200}`, with its own event ID. Then see what the fake platform received:

```sh
curl http://localhost:8090/sent
```

In order, that's:

| Action | Sent to | Text |
|---|---|---|
| `replyToComment` | the comment | Sent you a DM! |
| `sendDm` | the commenter, as a private reply | Hi! What's your email address? |
| `sendDm` | Alice, after her answer | Thanks, alice@example.com! Here's our pricing: https://example.com/pricing |

Alice's email is saved, and her run is complete:

```sh
docker compose exec postgres psql -U automations -c "SELECT contact_id, nickname, email FROM contacts"
```

```
 contact_id | nickname |       email
------------+----------+-------------------
 alice      | Alice    | alice@example.com
```

Stop everything with `docker compose down`. Postgres keeps its data in memory, so this also clears it.

## 4. Repository layout

```
packages/
  core/            state machine, validator, parser, engine and ports
  testkit/         memory store, contract suites and simulator
  store-postgres/  Postgres store, rate limiter and migrations
  transport-http/  webhook receiver
  platform-fake/   a fake platform's codec, gateway and policy
apps/
  server/          the backend: webhooks plus worker loops
  fake-platform/   plays the social platform locally
  e2e/             end-to-end script for the Docker stack
```

| Part | Status |
|---|---|
| Everything above | Built and tested |
| Automations loaded from a JSON file | Built |
| Postgres tables for automations | Designed |
| Mongo, gRPC, real Instagram and Facebook adapters | Designed for, not built |

"Designed" means the plan is described here, but there's no code for it.

**Scope:** the implementation focuses on the hard parts of the problem: durable execution, concurrency, deduplication, external side effects and recovery from failures. Real platform integrations and a customer-facing API for managing automations are deliberately out of scope, and documented as next steps.

## 5. Design

### 5.1. The core idea

A durable workflow has to survive for days, across restarts. That rules out holding its next step in a closure, because a closure can't be stored in a database. Turning that closure into data gives a **Mealy machine**:

```ts
const { state, effects, contact } = step(config, state, input);
```

- `step` reads no clock or database and sends nothing. It returns the next state, the effects to perform, and any change to the contact.
- The caller saves all three in one atomic write, and sends the effects afterwards.

This has one especially useful consequence: the run is already waiting for a reply before the DM asking for it goes out. A fast reply is never lost just because the platform hasn't confirmed delivery yet. Section 6.1 says exactly which messages count as a reply.

### 5.2. Theory behind

| Concept | In the system | What it gives us |
|---|---|---|
| Kleisli endomorphisms of `Writer<Effect[]>` on `S` | `step` | A pure core, tested without mocks |
| Free monoid action of `Input*` | `replay`, a fold over inputs | A replayable audit log |
| Defunctionalization | Nodes and extractors as JSON tags | Definitions that can be stored |
| Natural transformation `Effect ~> Task` | `sendEffects` and `PlatformGateway` | Swappable platform adapters |
| `Event → Option<Binding>` under the `First` monoid | `selectAutomation` | Deterministic priority |
| Dataflow over a semilattice | `forwardFlow` in the validator | Proof that variables are bound and policies are met |
| Algebraic theory and its models | `RunStore` and its adapters | One contract suite checks every database |

### 5.3. Architecture

```
HTTP webhook ──────┐
gRPC (designed) ───┴─ InboundEvent → inbox (dedupe) → Dispatcher ─ starts a run / routes a reply
                                                          │
Timer sweeper (wake_at) ───────────────────── one atomic write: state + log + contact + effects
                                                          │
                                                          ▼
                                     effects outbox → Effect worker → RateLimiter → PlatformGateway
                                                          ▲                              │
                                                          └──────── EffectSettled ───────┘
```

The core is agnostic along three separate axes:

| Axis | Port | How it stays agnostic |
|---|---|---|
| Database | `RunStore` | The port promises guarantees in domain terms, with no generic `transaction()` |
| Social platform | `PlatformPolicy`, `PlatformGateway` | Rules are data, and `PlatformId` is an opaque string the core never branches on |
| Transport | One `InboundEvent` type | Every source converges on it, giving N+M adapters rather than N×M |

### 5.4. The example flow

| State | Input | Next state | Effects |
|---|---|---|---|
| Idle | `Started` | Waiting | Reply to comment, then DM asking for email |
| Waiting | Reply contains an email | Completed | DM with the link |
| Waiting | Reply has no email, re-prompts left | Waiting | Re-prompt DM |
| Waiting | Reply has no email, none left | Abandoned | None |
| Waiting | `TimerFired` | Expired | None |
| Waiting | Ask DM failed for good | Failed | None |

The full definition is in `apps/server/automations.json`.

### 5.5. Platform constraints

Instagram's rules shaped the design, and they're expressed as a `PlatformPolicy` value:

- **One private reply:** a commenter can get one DM, within 7 days of the comment, addressed by comment ID.
- **Follow-up window:** further DMs need the user to respond first, and must go out within 24 hours of that response.
- **Rate limit:** third-party guides report 750 private replies per hour per account. At that rate, 10,000 matching comments take about 13 hours to clear.

These are different kinds of rule: eligibility windows, per-message limits and per-account rate limits. `PlatformPolicy` models each one separately, and a new platform may need rule kinds it doesn't have yet.

**Unverified assumptions,** to check against Meta's own documentation and a real integration before production:

- The 750-per-hour figure comes from third-party guides, not Meta. The fake platform's limits are illustrative only.
- A commenter's ID in comment webhooks is assumed to equal their sender ID in DM webhooks. Reply routing depends on it.

Source: [Meta: Private Replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies.md)

### 5.6. Data model

The first three tables are designed, not built. The rest are in `packages/store-postgres/migrations`.

| Table | Purpose | Key constraints |
|---|---|---|
| `automations` | Status, priority, active version | |
| `automation_accounts` | Which accounts an automation targets | Unique `(automation_id, social_account_id)` |
| `automation_versions` | Immutable `definition` JSON | Unique `(automation_id, version)` |
| `inbound_events` | Inbox | Unique `(platform, account_id, event_id)` |
| `runs` | `state` JSON, `active`, `wake_at`, pinned version | Primary key derived from the trigger event; partial unique `(platform, account_id, contact_id) WHERE active` |
| `run_transitions` | Audit log: input, effects, contact change, state after | Unique `(run_id, input_id)` |
| `effects` | Outbox: `effect` JSON, `status`, `attempts`, `failures`, `next_attempt_at`, `lease_until` | Unique `(run_id, seq)` |
| `contacts` | Platform, account, user ID, nickname and email (PII) | Unique `(platform, account_id, contact_id)` |
| `rate_limit_log` | Recent sends per limit | Indexed `(key, at)` |

### 5.7. Reliability

Each row is a guarantee of the store port, checked by the same contract suite on the memory store and on real Postgres. The Postgres column is how that adapter provides it.

| Hazard | Guarantee | Postgres |
|---|---|---|
| Duplicate webhooks | Each event is applied once | Unique `(platform, account_id, event_id)` |
| Same input delivered twice | Each input is applied once per run | Unique `(run_id, input_id)` |
| Two workers on one run | Transitions are serialized per run | `SELECT … FOR UPDATE` on the run |
| Crash mid-transition | State, log, contact and effects commit together | Transaction |
| Messages out of order | One event at a time per contact, oldest first | Claims only each contact's oldest event, with `SKIP LOCKED` |
| Double-triggered contact | One active run per account and contact | Partial unique index |
| Crash between send and mark-sent | At-least-once delivery | Leases on claimed effects |
| Viral post | One customer can't starve the others | Fair claiming across accounts |
| Burst of sends | Never over a platform's rate limit | Advisory lock per limit |
| Stuck query or lock | Fails instead of hanging | Lock, statement and connection timeouts |

Delivery is at-least-once, so a crash can occasionally produce a duplicate DM. A rare duplicate is a better failure than a lost lead. A lease can't prevent it, because the gap is between the platform and our database:

```
Worker                     Platform                  Postgres
  │──── send DM ──────────────▶│                         │
  │◀─── 200 OK ────────────────│                         │
  ✗ crash before the result is recorded                  │
                               │                         │  the lease expires
Another worker                 │                         │
  │──── send DM again ────────▶│  a duplicate            │
```

The only cure is on the platform's side. Every send carries a stable idempotency key, so a platform that honours one can drop the repeat.

## 6. Decisions

### 6.1. Product decisions

These are product questions rather than system design ones. This is a test project, so they're decided here and easy to change later.

| Question | Decision | Why |
|---|---|---|
| Can someone trigger an automation again after their run ends? | Yes, with no cooldown | It's simple, and they asked again |
| What if they trigger it again during an active run? | No new run; the event is logged as suppressed | Prevents duplicate DMs |
| What if a second automation matches during an active run? | Same: suppressed and logged | A DM reply must have exactly one addressee, or an email could reach the wrong flow. The cost: no parallel conversations with one person, which is fine for now |
| Which DMs count as a reply? | Any DM from that person that reaches us after their comment, even before delivery of the ask is confirmed. A DM that arrived before the comment is ignored | Each person's events are processed in arrival order. Delivery confirmation can lag the real delivery, and an early email is still a valid answer |
| What if several automations match one comment? | Only the highest priority runs | Two automations messaging one person is spam |
| What counts as a keyword match? | Case-insensitive whole word: "Pricing?" matches, "repricing" doesn't | Fewest false triggers |
| Do the account's own comments trigger anything? | No | Our own reply could otherwise retrigger the automation forever |
| What counts as an email? | The first email-shaped text in a reply, with no deliverability check | People write "sure, it's a@b.co thanks" |
| What if the reply isn't an email? | Re-prompt up to a per-automation limit, then abandon | Gives people a chance without nagging |
| What if they never reply? | The run expires silently after a per-automation timeout | Platform rules forbid reminders on Instagram |
| What if the comment reply fails? | Carry on | The DM is what matters |
| What if the final link DM fails? | The run stays Completed, and an `effectFailed` note is raised for alerting | The email is already captured |
| What if a rate-limit backlog delays the DM? | "Sent you a DM!" can go out well before the DM. A customer can avoid this by putting the DM step first | Holding replies back would need effects to reserve limits together, which isn't worth the complexity yet |
| What happens to in-flight runs when an automation is edited? | They finish on the version they started with | Changing a flow mid-conversation could strand a run |
| Is one person on two platforms one contact? | No, they're two contacts | Matching them would be guesswork with PII |
| What do we store about a contact? | Social platform, user ID, nickname if the platform gives one, and email | It's what a customer needs for a lead list |
| What if a contact gives a different email later? | The latest one replaces it | It's the address they most recently chose to give |

### 6.2. Engineering decisions

| Decision | Why |
|---|---|
| A graph of four node types, not a fixed pipeline or general DSL | Handling an invalid reply already needs a branch, and nothing needs more yet |
| Postgres with our own state machine, not Temporal | Customer-authored flows would still need this interpreter inside a workflow, plus a cluster to run. `step` could move to Temporal unchanged |
| State column as source of truth, plus a transition log | Simpler reads than full event sourcing. The simulator checks that folding the log gives the state |
| A run's ID is derived from its trigger event | Retrying that event can't create a second run, so no separate uniqueness check is needed |
| An effect's result and its run update are one atomic write | With two writes, a crash between them leaves a run waiting on an effect it can never hear about |
| Contact changes are an output of `step`, saved in the run's write | A crash can't lose a captured email or record one twice, and the logic stays pure |
| A failed run cancels its queued effects | A contact should never get messages from a dead flow. A completed run's final DM is unaffected |
| Timeouts start at delivery, not when queued | A long rate-limit backlog would otherwise use up the wait |
| A `RateLimiter` port checked by the effect worker, with limits in `PlatformPolicy` | Keeps the store simple to implement, while limits stay per-platform data |
| A sliding log for rate limits, not a token bucket | A token bucket can allow twice the limit within one window |
| Waiting for a rate limit doesn't count as a failed send | Otherwise a backlog alone would make effects give up |
| The engine is single steps with no loops inside | A server and a simulator can each schedule them their own way |
| A webhook is acknowledged only after it's stored | If storing fails, the platform gets a 503 and retries, so nothing is lost |
| Definitions are parsed and validated at startup | A bad flow stops the server instead of failing on the first comment |
| Automations come from a JSON file for now | Enough to run the system. The `AutomationCatalog` port lets database tables replace it later |
| Node's built-in `http`, no framework | The server has two routes, and webhook signatures need the raw body anyway |
| `pg` with plain SQL, no ORM | The guarantees depend on exact queries such as `SKIP LOCKED` |
| A fake platform instead of a real one | It enforces Instagram's messaging rules, so a policy violation shows up as a failed send. A real adapter would replace `packages/platform-fake` without touching the core |
| Plain discriminated unions, no fp-ts or Effect | Any TypeScript developer can read the code, with no library to learn first |

## 7. Implementation

### 7.1. The core package

`packages/core` has no runtime dependencies. Only the engine does I/O, and only through the ports.

| File | Responsibility |
|---|---|
| `definition.ts` | Flow graph types: triggers, nodes, `ValidDefinition` |
| `parse.ts` | `parseDefinition`: checks a definition's JSON shape and rejects unknown fields |
| `validate.ts` | `validate`, the only way to get a `ValidDefinition` |
| `machine.ts` | `step`, `replay`, `wakeAt` and the run state types |
| `trigger.ts` | Keyword matching and `selectAutomation` |
| `extract.ts` | Pulls a value such as an email out of free text |
| `render.ts` | Fills `{{variable}}` templates, in a single pass |
| `platform.ts` | `PlatformId`, `PlatformPolicy` and rate limits |
| `events.ts` | `InboundEvent`, the canonical form of everything received |
| `ports.ts` | `RunStore`, `PlatformGateway`, `RateLimiter`, `AutomationCatalog`, `Clock` |
| `engine/dispatcher.ts` | `dispatchNext`: turns one inbound event into a new run or a reply |
| `engine/effectWorker.ts` | `sendEffects`: deadlines, rate limits, sends, retries and backoff |
| `engine/timerSweeper.ts` | `fireTimers`: delivers due timeouts to their runs |

`RunStore` is four interfaces: `EventInbox`, `RunLog`, `EffectOutbox` and `ContactBook`. One adapter implements all four, because a single write can span them. Instead of a generic `transaction()`, each method is atomic and takes the pure transition as an argument, so an adapter can hold a lock or retry on a conflict.

#### Usage

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

In practice the engine does this for you: `createEngine` wires `step` to a store, a catalog, platforms, a rate limiter and a clock.

#### What validation guarantees

`step` only accepts a `ValidDefinition`. A definition passes only if:

- the entry and all edges exist, and every node is reachable
- every cycle goes through an `awaitReply`, so a run can't send messages forever
- every `{{variable}}` is bound on every path to where it's used
- it obeys the policy of every platform it targets, and errors name the platform that fails

The policy check is deliberately strict: it can reject a legal flow, but it should never accept an illegal one. For example, it rejects a DM on a timeout path unless the contact has definitely replied and the window is still open.

### 7.2. The testkit package

`packages/testkit` holds what tests need to stand in for the outside world.

| File | Responsibility |
|---|---|
| `memoryStore.ts` | `createMemoryStore`, a `RunStore` with no database |
| `storeContract.ts` | `describeRunStore`, the tests every store adapter must pass |
| `rateLimiter.ts` | `createMemoryRateLimiter` and `describeRateLimiter`, the limiter's contract |
| `harness.ts` | The whole engine wired to in-memory parts, with a fake clock and fake gateway |
| `simulator.ts` | Runs the engine through a schedule and checks the guarantees |
| `schedules.ts` | Generates schedules, and runs one on any store |

To test a new store adapter, pass a factory for a fresh store:

```ts
describeRunStore("postgres", async () => {
  await database.reset();
  return createPostgresStore(database.pool);
});
```

The memory store enforces the same constraints as a real database, but it's single-threaded. Its concurrency tests pass trivially, and only prove something on Postgres.

### 7.3. The Postgres package

`packages/store-postgres` implements `RunStore` and `RateLimiter`.

| File | Responsibility |
|---|---|
| `migrations/` | The schema, applied in name order by `migrate` |
| `src/runStore.ts` | `createPostgresStore` |
| `src/rateLimiter.ts` | `createPostgresRateLimiter` |
| `src/database.ts` | `createPool`, `migrate` and `inTransaction` |

Four details are easy to get wrong:

- **Claims re-check their conditions on the locked row.** `SKIP LOCKED` stops two workers locking one row at once, but a row can change between a query's snapshot and its lock. Without the re-check, an effect can be sent twice.
- **A run's transitions hold its row lock.** Every transition takes `FOR UPDATE` on the run first, which serializes them and gives a single lock order.
- **The JSON columns don't keep key order.** That's why state comparisons are structural, never on serialized strings.
- **Nothing waits forever.** `createPool` sets lock, statement, idle-transaction and connection timeouts. A stuck query then fails, and its lease expires so another worker retries.

### 7.4. The server and fake platform

| Part | Responsibility |
|---|---|
| `packages/transport-http` | `createWebhookHandler` serves `/webhooks/<platform>`: verifies the signature, decodes, stores, then acknowledges |
| `packages/platform-fake` | The fake platform's `WebhookCodec`, `PlatformGateway` and `PlatformPolicy`, shaped like Instagram's API |
| `apps/server` | Wires everything together and runs the worker loops; `GET /healthz` checks the database |
| `apps/fake-platform` | Simulates users, delivers signed webhooks, and receives what we send |
| `apps/e2e` | Drives the Docker stack through the pricing flow |

The fake platform's HTTP API:

| Route | Purpose |
|---|---|
| `POST /simulate/comment` | A user comments: `{ "account", "from", "text", "fromName"?, "id"? }`. Reusing an `id` replays the webhook |
| `POST /simulate/message` | A user sends a DM: `{ "account", "from", "text", "id"? }` |
| `GET /sent` | Everything we've sent, in order |
| `POST /fail-next` | Makes the next send fail: `{ "status", "retryAfterSeconds"? }` |
| `POST /send` | Where the server's gateway sends replies and DMs |

## 8. Testing

| Layer | What it shows | Where |
|---|---|---|
| Laws of `step` | The pure core is total, resumable from a snapshot, and safe under redelivery | `packages/core/test/laws.test.ts` |
| Validator soundness | Any flow that passes obeys its platform's rules under any inputs | `packages/core/test/laws.test.ts` |
| Store contract | Every guarantee in section 5.7, on each store adapter | `packages/testkit/src/storeContract.ts` |
| Simulator | The engine and store together, through crashes, faults, duplicates and reordering | `packages/testkit/src/simulator.ts` |
| Integration | The real server and fake platform over HTTP, in one process | `apps/server/test/integration.test.ts` |
| End to end | The Docker stack, with the server killed mid-flow | `apps/e2e/src/main.ts` |

While building this, each safeguard was removed on purpose to confirm a test fails without it: locks, indexes, deduplication, re-checks, retries and so on. Those scripts aren't part of the repo.

### 8.1. Laws of the core

These run on generated flows and input sequences using fast-check.

| Law | Meaning |
|---|---|
| Totality | Any state accepts any input without throwing; an input with no meaning there changes nothing |
| Absorption | A finished run ignores everything |
| Monoid action | Resuming from a JSON snapshot equals one unbroken run |
| Redelivery | Duplicate inputs change nothing once deduplicated by id |
| Validator soundness | Any flow that passes obeys the platform policy under any inputs, and never shows an unfilled placeholder |

### 8.2. What the simulator checks

A schedule is a generated list of: webhook deliveries in any order and with duplicates, contacts answering once they've been DMed, engine steps (some concurrent), clock jumps, crashes before or after any store write, and gateway failures. Afterwards it drains: everyone with an email answers, and time runs forward until every run ends. It checks:

| Guarantee | Meaning |
|---|---|
| One active run | A contact never has two unfinished runs |
| Rate limits | Sends never exceed a limit in any window |
| Platform rules | One private reply per comment, within its window; other DMs only within a day of a reply |
| Agreement with the fold | Each stored state and outbox equals `replay` of that run's log |
| Nothing lost | Every matching comment starts a run or is recorded as suppressed |
| Nothing stuck | Every run finishes, and no event or effect is left behind |
| No lost leads | A captured email gets its link, unless a fault was injected on that very send |
| Order | A run's messages go out in order |
| No duplicates without faults | With no crashes or gateway failures, no message is sent twice |

That last row is about our own system. Delivery to a real platform stays at-least-once, as section 5.7 explains.

On the memory store, concurrency means interleaving at `await` points. The same schedules also run on Postgres, where workers really do run in parallel. Each Postgres test file gets its own schema, so these tests can run in parallel and can't touch other data.

### 8.3. The end-to-end test

`pnpm e2e` builds and starts the Docker stack, then:

1. Alice comments "Pricing?", and Bob comments off-topic.
2. The server is killed with `SIGKILL`, before Alice answers.
3. Alice answers while it's down, so the webhook fails.
4. The server restarts, and the platform delivers her answer twice.
5. It checks that exactly one reply, one ask and one link were sent, nothing went to Bob, and Alice's run and contact are saved in Postgres.

## 9. Production considerations

None of this is built beyond what's stated. It's what running the system for real customers would need.

### 9.1. Tenant isolation

- **Built:** every event, run, effect and contact is keyed by platform and account. Lookups by contact filter on both, and run IDs are derived from them. A webhook must carry a valid signature, and events for an account with no registered automations start nothing.
- **Not built:** proving a customer owns a social account before connecting it, and an authenticated API for customers to manage their automations. A webhook signature proves the platform sent it, not which customer the account belongs to. That mapping would live in the designed `automations` and `automation_accounts` tables.

### 9.2. Observability

- **Built:** JSON log lines; `runSuppressed` notes carrying the event and `effectFailed` notes carrying the run; a run's full history in `run_transitions`; and each effect's status, attempts and last error in `effects`.
- **Next:**
    - **metrics:** inbox and outbox backlog, age of the oldest queued effect, send latency, and retries and failures per platform
    - **alerts:** repeatedly failing effects and a growing backlog
    - **traceability:** run and event IDs on every log line, including engine errors, which don't carry them yet

## 10. Known limitations

| Category | Limitation | Effect | Way forward |
|---|---|---|---|
| By design | At-least-once delivery | A crash between a send and its record can repeat a message | Pass the idempotency key to platforms that honour one |
| Implementation | Notes aren't durable | A crash can lose a "suppressed" or "effect failed" log line, though never run state | Write them to a table in the same transaction |
| Implementation | No dead-letter queue | An event that always fails, such as one from an unregistered platform, retries forever and blocks only that contact | Count attempts on events, and park them after a limit |
| Implementation | No retention | Processed events, transitions and rate-limit rows are kept forever | A cleanup job with a retention period |
| Implementation | NUL characters | Postgres rejects `\u0000` in JSON and text, so such a message can't be stored and is retried | Strip it in the codecs |
| Implementation | No automations API | Automations come from a JSON file loaded at startup | The designed tables behind `AutomationCatalog` |
| Production | Arrival order, not platform time | A contact's events are processed in the order they reached us | Usually the same; platforms don't guarantee order anyway |
| Production | Clocks per worker | Leases and timers use each worker's own clock, so large clock skew could cut a lease short | Keep clocks synced, or use the database's clock |
| Assumption | Fake platform only | The real Meta rules, rate limits and ID mapping are unverified | A real adapter, and checking the points in section 5.5 |

## 11. Development

Node runs the TypeScript directly, so there's no build step.

```sh
pnpm install
pnpm test       # fast tests only, no Docker needed
pnpm typecheck

pnpm db:up      # start Postgres in Docker, with its data in memory
pnpm test:db    # everything, including Postgres
pnpm db:down

pnpm e2e        # the whole stack in Docker, about a minute
```

- `pnpm test` skips the Postgres tests when `TEST_DATABASE_URL` isn't set.
- `SIMULATOR_RUNS` sets how many schedules the Postgres simulator tries (default 15).
- `KEEP=1 pnpm e2e` leaves the stack running afterwards.
- `docker compose up --build` runs the server on port 8080 and the fake platform on port 8090. The webhook secret in `compose.yaml` is for local development only.

## 12. AI usage

I built this with Claude Code as an AI pair programmer. We worked in short milestones, and I committed each one myself after reviewing it, adopting a **Spec-Driven Development / Human-in-the-Loop (HITL)** methodology.

### 12.1. What I did

- **Architecture and design:** Defined the system boundaries, execution model, persistence strategy, concurrency guarantees, and technology choices.
- **Technical specifications:** Defined module responsibilities, interfaces, behavioral requirements, and important edge cases before implementation.
- **Engineering decisions:** Evaluated trade-offs, challenged proposed solutions, and made the final architectural and implementation decisions.
- **Review and validation:** Reviewed generated changes, ran the test suites, investigated failures, and verified the behavior against the intended guarantees.

### 12.2. What Claude did

- **Scaffolding & Boilerplate:** Delegated repetitive syntax writing, boilerplate file structures, and standard configuration setups to accelerate initial setup.
- **Rapid Prototyping:** Used Claude Code to rapidly draft iterative implementations of complex logic modules based on my explicit architectural constraints.
- **Refactoring & Optimization:** Leveraged the agent to refactor local blocks for readability and to implement specific language idiom patterns quickly.

### 12.3. Summary of Control

While Claude Code handled the mechanical translation of intent into syntax, all the architectural decisions, structural constraints, and quality gates were human-driven. AI-generated code was treated as a proposal rather than an authoritative implementation, while I stay responsible for reviewing the changes and validating their behavior.

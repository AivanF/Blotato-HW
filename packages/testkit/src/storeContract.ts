import {
  platformId,
  type AccountRef,
  type ContactPatch,
  type Effect,
  type InboundEvent,
  type Input,
  type Instant,
  type RunRef,
  type RunState,
  type RunStore,
  type TransitionFn,
  type WaitingState,
} from "@automations/core";
import { beforeEach, describe, expect, it } from "vitest";

const account: AccountRef = { platform: platformId("test"), accountId: "account-1" };
const otherAccount: AccountRef = { platform: platformId("test"), accountId: "account-2" };

const LEASE = 100;

const comment = (eventId: string, contact: string, overrides: Partial<EventBase> = {}): InboundEvent => ({
  platform: account.platform,
  accountId: account.accountId,
  eventId,
  kind: "comment",
  commentId: `comment-${eventId}`,
  postId: "post-1",
  authorId: contact,
  text: "pricing",
  occurredAt: 0,
  ...overrides,
});

type EventBase = Pick<InboundEvent, "platform" | "accountId">;

const runRef = (runId: string, contactId = "contact-1", owner = account): RunRef => ({
  runId,
  versionId: "version-1",
  account: owner,
  contactId,
});

const waiting = (overrides: Partial<WaitingState> = {}): WaitingState => ({
  tag: "waiting",
  node: "wait",
  comment: { commentId: "c", postId: "p", authorId: "a", text: "t", occurredAt: 0 },
  bindings: {},
  reprompts: 0,
  lastReplyAt: null,
  nextSeq: 0,
  pending: [],
  timerArmedBy: null,
  deadline: null,
  ...overrides,
});

const completed: RunState = { tag: "done", outcome: "completed", bindings: {} };
const failed: RunState = { tag: "done", outcome: "failed", bindings: {} };

const effect = (seq: number): Effect => ({
  seq,
  action: { kind: "replyToComment", commentId: "c", text: `effect ${seq}` },
  onFailure: "continue",
  notAfter: null,
});

const to =
  (state: RunState, effects: readonly Effect[] = []): TransitionFn =>
  () => ({ state, effects });

const input = (id: string, tag: "Replied" | "TimerFired" = "TimerFired"): Input =>
  tag === "Replied" ? { tag, id, at: 0, text: "hi" } : { tag, id, at: 0 };

const start = (id = "start"): Input => input(id);

const settled = (seq: number): Input => ({
  tag: "EffectSettled",
  id: `settled-${seq}`,
  at: 0,
  seq,
  ok: true,
});

/**
 * The theory every store adapter must model. Add a hazard here and every adapter is held to
 * it. The tests only read through the port, so they can't depend on how an adapter works.
 */
export const describeRunStore = (name: string, createStore: () => Promise<RunStore>): void => {
  describe(`RunStore contract: ${name}`, () => {
    let store: RunStore;

    beforeEach(async () => {
      store = await createStore();
    });

    const claimedIds = async (now: Instant, limit = 10): Promise<readonly string[]> =>
      (await store.claimEffects(now, limit, LEASE)).map(
        ({ run, effect: { seq } }) => `${run.runId}:${seq}`,
      );

    describe("inbox", () => {
      it("drops an event it has already seen", async () => {
        await store.appendEvents([comment("e1", "alice"), comment("e1", "alice")]);
        await store.appendEvents([comment("e1", "alice")]);
        expect((await store.claimEvent(0, LEASE))?.eventId).toBe("e1");
        await store.completeEvent(comment("e1", "alice"));
        expect(await store.claimEvent(0, LEASE)).toBeNull();
      });

      it("scopes event ids by platform and account", async () => {
        await store.appendEvents([
          comment("e1", "alice"),
          comment("e1", "bob", { accountId: "account-2" }),
          comment("e1", "carol", { platform: platformId("other") }),
        ]);
        const claims = await Promise.all([0, 1, 2].map(() => store.claimEvent(0, LEASE)));
        expect(claims.every((claim) => claim !== null)).toBe(true);
      });

      it("hands out one contact's events one at a time, oldest first", async () => {
        await store.appendEvents([comment("e1", "alice"), comment("e2", "alice")]);
        expect((await store.claimEvent(0, LEASE))?.eventId).toBe("e1");
        expect(await store.claimEvent(0, LEASE)).toBeNull();
        await store.completeEvent(comment("e1", "alice"));
        expect((await store.claimEvent(0, LEASE))?.eventId).toBe("e2");
      });

      it("doesn't let one contact block another", async () => {
        await store.appendEvents([comment("e1", "alice"), comment("e2", "bob")]);
        expect((await store.claimEvent(0, LEASE))?.eventId).toBe("e1");
        expect((await store.claimEvent(0, LEASE))?.eventId).toBe("e2");
      });

      it("hands an event out again when its lease expires", async () => {
        await store.appendEvents([comment("e1", "alice")]);
        await store.claimEvent(0, LEASE);
        expect(await store.claimEvent(LEASE - 1, LEASE)).toBeNull();
        expect((await store.claimEvent(LEASE, LEASE))?.eventId).toBe("e1");
      });
    });

    describe("starting runs", () => {
      it("saves the state, log entry and effects together", async () => {
        const state = waiting();
        expect(await store.startRun(runRef("r1"), start(), to(state, [effect(0)]))).toBe("started");
        expect((await store.getRun("r1"))?.state).toEqual(state);
        expect(await store.transitions("r1")).toEqual([
          { input: start(), effects: [effect(0)], state },
        ]);
        expect((await store.effects("r1")).map((row) => row.status)).toEqual(["queued"]);
      });

      it("reports a repeated run id as a duplicate without calling the transition", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting()));
        const never: TransitionFn = () => {
          throw new Error("must not be called");
        };
        expect(await store.startRun(runRef("r1"), start(), never)).toBe("duplicate");
      });

      it("reports a duplicate even once the same run has finished", async () => {
        await store.startRun(runRef("r1"), start(), to(completed));
        expect(await store.startRun(runRef("r1"), start(), to(waiting()))).toBe("duplicate");
      });

      it("suppresses a second run for a contact with an active run", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting()));
        expect(await store.startRun(runRef("r2"), start(), to(waiting()))).toBe("suppressed");
        expect(await store.getRun("r2")).toBeNull();
      });

      it("scopes suppression to the account and the contact", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting()));
        expect(await store.startRun(runRef("r2", "bob"), start(), to(waiting()))).toBe("started");
        expect(
          await store.startRun(runRef("r3", "contact-1", otherAccount), start(), to(waiting())),
        ).toBe("started");
      });

      it("allows triggering again once the earlier run has ended", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting()));
        await store.applyInput("r1", input("end"), to(completed));
        expect(await store.startRun(runRef("r2"), start(), to(waiting()))).toBe("started");
      });

      it("saves nothing if the transition throws", async () => {
        const boom: TransitionFn = () => {
          throw new Error("boom");
        };
        await expect(store.startRun(runRef("r1"), start(), boom)).rejects.toThrow("boom");
        expect(await store.getRun("r1")).toBeNull();
        expect(await store.getContact(account, "contact-1")).toBeNull();
        expect(await store.startRun(runRef("r2"), start(), to(waiting()))).toBe("started");
      });
    });

    describe("applying inputs", () => {
      beforeEach(async () => {
        await store.startRun(runRef("r1"), start(), to(waiting({ reprompts: 1 })));
      });

      it("passes the current state and input to the transition", async () => {
        let seen: readonly [RunState, Input] | null = null;
        await store.applyInput("r1", input("i1"), (state, applied) => {
          seen = [state, applied];
          return { state, effects: [] };
        });
        expect(seen).toEqual([waiting({ reprompts: 1 }), input("i1")]);
      });

      it("applies each input id once, without calling the transition again", async () => {
        expect(await store.applyInput("r1", input("i1"), to(waiting({ reprompts: 2 })))).toBe(
          "applied",
        );
        const never: TransitionFn = () => {
          throw new Error("must not be called");
        };
        expect(await store.applyInput("r1", input("i1"), never)).toBe("duplicate");
        expect((await store.transitions("r1")).length).toBe(2);
      });

      it("reports an unknown run", async () => {
        expect(await store.applyInput("nope", input("i1"), to(completed))).toBe("unknownRun");
      });

      it("keeps a log that replays to the current state", async () => {
        await store.applyInput("r1", input("i1"), to(waiting({ reprompts: 2 })));
        await store.applyInput("r1", input("i2"), to(completed));
        const log = await store.transitions("r1");
        expect(log.map((entry) => entry.input.id)).toEqual(["start", "i1", "i2"]);
        expect(log.at(-1)?.state).toEqual((await store.getRun("r1"))?.state);
      });

      it("changes nothing if the transition throws, and accepts that input id later", async () => {
        const boom: TransitionFn = () => {
          throw new Error("boom");
        };
        await expect(store.applyInput("r1", input("i1"), boom)).rejects.toThrow("boom");
        expect((await store.getRun("r1"))?.state).toEqual(waiting({ reprompts: 1 }));
        expect((await store.transitions("r1")).length).toBe(1);
        expect(await store.applyInput("r1", input("i1"), to(completed))).toBe("applied");
      });

      it("doesn't let a caller change stored state through a returned value", async () => {
        const record = await store.getRun("r1");
        (record?.state as { reprompts: number }).reprompts = 99;
        expect((await store.getRun("r1"))?.state).toEqual(waiting({ reprompts: 1 }));
      });

      it("finds a run only while it is active", async () => {
        expect((await store.findActiveRun(account, "contact-1"))?.runId).toBe("r1");
        expect(await store.findActiveRun(otherAccount, "contact-1")).toBeNull();
        expect(await store.findActiveRun(account, "bob")).toBeNull();
        await store.applyInput("r1", input("end"), to(completed));
        expect(await store.findActiveRun(account, "contact-1")).toBeNull();
      });
    });

    describe("timers", () => {
      it("returns due runs oldest first, up to the limit", async () => {
        await store.startRun(runRef("late", "a"), start(), to(waiting({ deadline: 20 })));
        await store.startRun(runRef("early", "b"), start(), to(waiting({ deadline: 10 })));
        await store.startRun(runRef("future", "c"), start(), to(waiting({ deadline: 99 })));
        expect((await store.dueRuns(50, 10)).map((due) => [due.run.runId, due.wakeAt])).toEqual([
          ["early", 10],
          ["late", 20],
        ]);
        expect((await store.dueRuns(50, 1)).map((due) => due.run.runId)).toEqual(["early"]);
      });

      it("skips a run with no deadline", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting()));
        expect(await store.dueRuns(1_000, 10)).toEqual([]);
      });

      it("follows the run's state as it changes", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting({ deadline: 10 })));
        await store.applyInput("r1", input("later"), to(waiting({ deadline: 500 })));
        expect(await store.dueRuns(50, 10)).toEqual([]);
        await store.applyInput("r1", input("end"), to(completed));
        expect(await store.dueRuns(1_000, 10)).toEqual([]);
      });
    });

    describe("outbox", () => {
      const startWithEffects = (runId = "r1", contact = "contact-1", owner = account) =>
        store.startRun(runRef(runId, contact, owner), start(), to(waiting(), [effect(0), effect(1)]));

      const deliver = (seq: number, state: RunState = waiting(), runId = "r1") =>
        store.finishEffect({ runId, seq }, { tag: "delivered" }, settled(seq), to(state));

      it("hands out a run's effects one at a time, in order", async () => {
        await startWithEffects();
        expect(await claimedIds(0)).toEqual(["r1:0"]);
        expect(await claimedIds(0)).toEqual([]);
        await deliver(0);
        expect(await claimedIds(0)).toEqual(["r1:1"]);
      });

      it("hands an effect out again when its lease expires, as a new attempt", async () => {
        await startWithEffects();
        const [first] = await store.claimEffects(0, 10, LEASE);
        expect(first?.attempt).toBe(1);
        expect(await claimedIds(LEASE - 1)).toEqual([]);
        const [second] = await store.claimEffects(LEASE, 10, LEASE);
        expect(second?.effect.seq).toBe(0);
        expect(second?.attempt).toBe(2);
      });

      it("holds a retried effect until its retry time, keeping the run's order", async () => {
        await startWithEffects();
        await store.claimEffects(0, 10, LEASE);
        await store.retryEffect({ runId: "r1", seq: 0 }, 1, 50, "rate limited");
        expect(await claimedIds(49)).toEqual([]);
        expect(await claimedIds(50)).toEqual(["r1:0"]);
        expect((await store.effects("r1"))[0]?.lastError).toBe("rate limited");
      });

      it("ignores a retry from an older claim, so two workers can't send at once", async () => {
        await startWithEffects();
        await store.claimEffects(0, 10, LEASE);
        await store.claimEffects(LEASE, 10, LEASE);
        await store.retryEffect({ runId: "r1", seq: 0 }, 1, 0, "stale worker");
        expect(await claimedIds(LEASE + 1)).toEqual([]);
      });

      it("records a result and applies its input in one write", async () => {
        await startWithEffects();
        await store.claimEffects(0, 10, LEASE);
        await deliver(0, waiting({ reprompts: 7 }));
        expect((await store.effects("r1"))[0]?.status).toBe("delivered");
        expect((await store.getRun("r1"))?.state).toEqual(waiting({ reprompts: 7 }));
      });

      it("records nothing if finishing's transition throws", async () => {
        await startWithEffects();
        await store.claimEffects(0, 10, LEASE);
        const boom: TransitionFn = () => {
          throw new Error("boom");
        };
        await expect(
          store.finishEffect({ runId: "r1", seq: 0 }, { tag: "delivered" }, settled(0), boom),
        ).rejects.toThrow("boom");
        expect((await store.effects("r1"))[0]?.status).toBe("queued");
      });

      it("keeps the first result, and applies a repeated input only once", async () => {
        await startWithEffects();
        await store.claimEffects(0, 10, LEASE);
        await deliver(0);
        await store.finishEffect(
          { runId: "r1", seq: 0 },
          { tag: "failed", error: "late" },
          settled(0),
          to(failed),
        );
        expect((await store.effects("r1"))[0]?.status).toBe("delivered");
        expect((await store.getRun("r1"))?.state).toEqual(waiting());
      });

      it("cancels queued effects when a run fails, in the same write", async () => {
        await startWithEffects();
        await store.claimEffects(0, 10, LEASE);
        await store.finishEffect(
          { runId: "r1", seq: 0 },
          { tag: "failed", error: "blocked" },
          settled(0),
          to(failed),
        );
        expect((await store.effects("r1")).map((row) => row.status)).toEqual([
          "failed",
          "cancelled",
        ]);
        expect(await claimedIds(1_000)).toEqual([]);
      });

      it("still sends queued effects when a run completes", async () => {
        await startWithEffects();
        await store.applyInput("r1", input("end"), to(completed));
        expect(await claimedIds(0)).toEqual(["r1:0"]);
      });

      it("keeps a completed run completed when its last effect fails", async () => {
        await startWithEffects();
        await store.applyInput("r1", input("end"), to(completed));
        await store.claimEffects(0, 10, LEASE);
        await store.finishEffect(
          { runId: "r1", seq: 0 },
          { tag: "failed", error: "blocked" },
          settled(0),
          (state) => ({ state, effects: [] }),
        );
        expect((await store.getRun("r1"))?.state).toEqual(completed);
        expect((await store.effects("r1"))[0]).toMatchObject({
          status: "failed",
          lastError: "blocked",
        });
      });

      it("lets the real result of an in-flight effect replace its cancellation", async () => {
        await startWithEffects();
        await store.claimEffects(0, 10, LEASE);
        await store.applyInput("r1", input("fail"), to(failed));
        expect((await store.effects("r1"))[0]?.status).toBe("cancelled");
        await deliver(0, failed);
        expect((await store.effects("r1"))[0]?.status).toBe("delivered");
      });

      it("ignores a retry on a cancelled effect", async () => {
        await startWithEffects();
        await store.claimEffects(0, 10, LEASE);
        await store.applyInput("r1", input("fail"), to(failed));
        await store.retryEffect({ runId: "r1", seq: 0 }, 1, 0, "too late");
        expect(await claimedIds(1_000)).toEqual([]);
      });

      it("shares a claim between accounts, so one busy account can't starve the rest", async () => {
        await startWithEffects("busy-1", "a");
        await startWithEffects("busy-2", "b");
        await startWithEffects("busy-3", "c");
        await startWithEffects("quiet", "a", otherAccount);
        expect(await claimedIds(0, 2)).toEqual(["busy-1:0", "quiet:0"]);
        expect(await claimedIds(0, 2)).toEqual(["busy-2:0", "busy-3:0"]);
      });
    });

    describe("contacts", () => {
      const withContact =
        (contact: ContactPatch, state: RunState = waiting()): TransitionFn =>
        () => ({ state, effects: [], contact });

      it("creates a contact with its platform, user ID and nickname", async () => {
        await store.startRun(runRef("r1"), start(), withContact({ nickname: "ada" }));
        expect(await store.getContact(account, "contact-1")).toEqual({
          account,
          contactId: "contact-1",
          nickname: "ada",
          email: null,
        });
      });

      it("creates a contact from an empty patch, when no nickname is known", async () => {
        await store.startRun(runRef("r1"), start(), withContact({}));
        expect(await store.getContact(account, "contact-1")).toMatchObject({
          nickname: null,
          email: null,
        });
      });

      it("creates nothing when a transition has no patch", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting()));
        expect(await store.getContact(account, "contact-1")).toBeNull();
      });

      it("merges a patch, leaving missing fields alone", async () => {
        await store.startRun(runRef("r1"), start(), withContact({ nickname: "ada" }));
        await store.applyInput("r1", input("i1"), withContact({ email: "ada@example.com" }));
        await store.applyInput("r1", input("i2"), withContact({}));
        expect(await store.getContact(account, "contact-1")).toMatchObject({
          nickname: "ada",
          email: "ada@example.com",
        });
      });

      it("keeps a contact across runs, with the latest email winning", async () => {
        await store.startRun(
          runRef("r1"),
          start(),
          withContact({ nickname: "ada", email: "old@example.com" }, completed),
        );
        await store.startRun(runRef("r2"), start(), withContact({ email: "new@example.com" }));
        expect(await store.getContact(account, "contact-1")).toMatchObject({
          nickname: "ada",
          email: "new@example.com",
        });
      });

      it("keeps one contact per account and user ID", async () => {
        await store.startRun(runRef("r1"), start(), withContact({ nickname: "ada" }));
        await store.startRun(runRef("r2", "bob"), start(), withContact({ nickname: "bob" }));
        await store.startRun(
          runRef("r3", "contact-1", otherAccount),
          start(),
          withContact({ nickname: "other" }),
        );
        expect((await store.getContact(account, "contact-1"))?.nickname).toBe("ada");
        expect((await store.getContact(account, "bob"))?.nickname).toBe("bob");
        expect((await store.getContact(otherAccount, "contact-1"))?.nickname).toBe("other");
      });

      it("doesn't apply a patch again for a repeated input", async () => {
        await store.startRun(runRef("r1"), start(), withContact({}));
        await store.applyInput("r1", input("i1"), withContact({ email: "first@example.com" }));
        await store.applyInput("r1", input("i1"), withContact({ email: "second@example.com" }));
        expect((await store.getContact(account, "contact-1"))?.email).toBe("first@example.com");
      });

      it("saves the patch in the run's log", async () => {
        await store.startRun(runRef("r1"), start(), withContact({ nickname: "ada" }));
        expect((await store.transitions("r1"))[0]?.contact).toEqual({ nickname: "ada" });
      });

      it("applies a patch delivered with an effect's result", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting(), [effect(0)]));
        await store.finishEffect(
          { runId: "r1", seq: 0 },
          { tag: "delivered" },
          settled(0),
          withContact({ email: "ada@example.com" }),
        );
        expect((await store.getContact(account, "contact-1"))?.email).toBe("ada@example.com");
      });

      it("doesn't let a caller change a stored contact through a returned value", async () => {
        await store.startRun(runRef("r1"), start(), withContact({ nickname: "ada" }));
        const contact = await store.getContact(account, "contact-1");
        (contact as { nickname: string }).nickname = "changed";
        expect((await store.getContact(account, "contact-1"))?.nickname).toBe("ada");
      });

      it("loses no field when different inputs patch one contact at once", async () => {
        await store.startRun(runRef("r1"), start(), withContact({}));
        await Promise.all([
          store.applyInput("r1", input("i1"), withContact({ nickname: "ada" })),
          store.applyInput("r1", input("i2"), withContact({ email: "ada@example.com" })),
        ]);
        expect(await store.getContact(account, "contact-1")).toMatchObject({
          nickname: "ada",
          email: "ada@example.com",
        });
      });
    });

    describe("under concurrent calls", () => {
      const WORKERS = 16;
      const workers = <T>(task: (index: number) => Promise<T>): Promise<readonly T[]> =>
        Promise.all(Array.from({ length: WORKERS }, (_, index) => task(index)));

      it("starts one run when a contact triggers many at once", async () => {
        const results = await workers((index) =>
          store.startRun(runRef(`r${index}`), start(), to(waiting())),
        );
        expect(results.filter((result) => result === "started")).toHaveLength(1);
        expect(results.filter((result) => result === "suppressed")).toHaveLength(WORKERS - 1);
      });

      it("starts one run when the same event is processed many times", async () => {
        const results = await workers(() => store.startRun(runRef("r1"), start(), to(waiting())));
        expect(results.filter((result) => result === "started")).toHaveLength(1);
        expect(results.filter((result) => result === "duplicate")).toHaveLength(WORKERS - 1);
      });

      it("applies one input once, however many workers deliver it", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting()));
        const results = await workers(() => store.applyInput("r1", input("i1"), to(completed)));
        expect(results.filter((result) => result === "applied")).toHaveLength(1);
      });

      it("loses no update when workers apply different inputs", async () => {
        await store.startRun(runRef("r1"), start(), to(waiting()));
        await workers((index) =>
          store.applyInput("r1", input(`i${index}`), (state) => ({
            state: { ...(state as WaitingState), reprompts: (state as WaitingState).reprompts + 1 },
            effects: [],
          })),
        );
        expect((await store.getRun("r1"))?.state).toMatchObject({ reprompts: WORKERS });
      });

      it("hands each effect to one worker", async () => {
        await Promise.all(
          Array.from({ length: WORKERS }, (_, index) =>
            store.startRun(runRef(`r${index}`, `contact-${index}`), start(), to(waiting(), [effect(0)])),
          ),
        );
        const claims = (await workers(() => store.claimEffects(0, 4, LEASE))).flat();
        const ids = claims.map((claim) => claim.run.runId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(WORKERS);
      });

      it("hands a contact's events to one worker at a time", async () => {
        await store.appendEvents(
          Array.from({ length: WORKERS }, (_, index) => comment(`e${index}`, "alice")),
        );
        const claims = await workers(() => store.claimEvent(0, LEASE));
        expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      });
    });
  });
};

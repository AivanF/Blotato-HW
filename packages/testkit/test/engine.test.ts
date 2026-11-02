import { runIdFor, type InboundEvent, type PlatformPolicy } from "@automations/core";
import { describe, expect, it } from "vitest";
import {
  commentEvent,
  createHarness,
  DAY,
  HOUR,
  LINK,
  messageEvent,
  pricingDefinition,
  SELF_ID,
  testAccount,
  testPolicy,
  type Harness,
} from "../src/index.ts";

const settle = async ({ engine }: Harness): Promise<void> => {
  while (await engine.dispatchNext());
  while ((await engine.sendEffects(10)) > 0);
};

const receive = async (harness: Harness, ...events: readonly InboundEvent[]): Promise<void> => {
  await harness.store.appendEvents(events);
  await settle(harness);
};

const comment = (harness: Harness, id = "c1", contact = "alice", text?: string) =>
  commentEvent(id, contact, harness.clock.now(), text);

const reply = (harness: Harness, id: string, text: string, contact = "alice") =>
  messageEvent(id, contact, harness.clock.now(), text);

const stateOf = async (harness: Harness, event: InboundEvent) =>
  (await harness.store.getRun(runIdFor(event)))?.state;

const texts = (harness: Harness): readonly string[] =>
  harness.gateway.sent.map((message) => message.action.text);

describe("the pricing flow, end to end", () => {
  it("replies, asks, waits, then sends the link and saves the contact", async () => {
    const harness = createHarness();
    const trigger = { ...comment(harness), authorName: "ada" } as InboundEvent;

    await receive(harness, trigger);
    expect(texts(harness)).toEqual(["Sent you a DM!", "What's your email?"]);
    expect((await stateOf(harness, trigger))?.tag).toBe("waiting");

    await receive(harness, reply(harness, "m1", "sure, ada@example.com"));
    expect(texts(harness).at(-1)).toBe(`Thanks ada@example.com! ${LINK}`);
    expect(await stateOf(harness, trigger)).toMatchObject({ tag: "done", outcome: "completed" });
    expect(await harness.store.getContact(testAccount, "alice")).toEqual({
      account: testAccount,
      contactId: "alice",
      nickname: "ada",
      email: "ada@example.com",
    });
  });

  it("addresses the first DM through the comment and the next to the contact", async () => {
    const harness = createHarness();
    await receive(harness, comment(harness), reply(harness, "m1", "ada@example.com"));
    const dms = harness.gateway.sent.flatMap(({ action }) =>
      action.kind === "sendDm" ? [action.recipient.kind] : [],
    );
    expect(dms).toEqual(["viaComment", "contact"]);
  });

  it("re-prompts on an invalid reply", async () => {
    const harness = createHarness();
    await receive(harness, comment(harness), reply(harness, "m1", "how much?"));
    expect(texts(harness).at(-1)).toContain("doesn't look like an email");
  });

  it("expires a run nobody replies to, sending nothing more", async () => {
    const harness = createHarness();
    const trigger = comment(harness);
    await receive(harness, trigger);
    const sentBefore = harness.gateway.sent.length;
    harness.clock.advance(72 * HOUR);
    expect(await harness.engine.fireTimers(10)).toBe(1);
    expect(await stateOf(harness, trigger)).toMatchObject({ tag: "done", outcome: "expired" });
    expect(harness.gateway.sent).toHaveLength(sentBefore);
  });
});

describe("dispatching", () => {
  it("ignores a comment that doesn't match", async () => {
    const harness = createHarness();
    const trigger = comment(harness, "c1", "alice", "nice photo");
    await receive(harness, trigger);
    expect(await harness.store.getRun(runIdFor(trigger))).toBeNull();
    expect(harness.gateway.sent).toEqual([]);
  });

  it("ignores the account's own comments", async () => {
    const harness = createHarness();
    await receive(harness, comment(harness, "c1", SELF_ID));
    expect(harness.gateway.sent).toEqual([]);
  });

  it("ignores a DM from someone with no active run", async () => {
    const harness = createHarness();
    await receive(harness, reply(harness, "m1", "ada@example.com"));
    expect(harness.gateway.sent).toEqual([]);
    expect(await harness.store.getContact(testAccount, "alice")).toBeNull();
  });

  it("runs only the highest-priority automation", async () => {
    const other = {
      ...pricingDefinition,
      nodes: {
        ...pricingDefinition.nodes,
        reply: { kind: "replyToComment", text: "Other", onFailure: "continue", next: "ask" },
      },
    } as typeof pricingDefinition;
    const harness = createHarness({
      automations: [
        { versionId: "first", definition: pricingDefinition },
        { versionId: "second", definition: other },
      ],
    });
    await receive(harness, comment(harness));
    expect(texts(harness)).not.toContain("Other");
  });

  it("suppresses and notes a second trigger during an active run", async () => {
    const harness = createHarness();
    await receive(harness, comment(harness, "c1"));
    const sentBefore = harness.gateway.sent.length;
    await receive(harness, comment(harness, "c2"));
    expect(harness.gateway.sent).toHaveLength(sentBefore);
    expect(harness.notes).toMatchObject([{ tag: "runSuppressed", versionId: "pricing-v1" }]);
  });

  it("lets someone trigger again once their run has ended", async () => {
    const harness = createHarness();
    await receive(harness, comment(harness, "c1"), reply(harness, "m1", "ada@example.com"));
    const again = comment(harness, "c2");
    await receive(harness, again);
    expect((await stateOf(harness, again))?.tag).toBe("waiting");
  });

  it("doesn't start a run twice when a webhook is redelivered", async () => {
    const harness = createHarness();
    const trigger = comment(harness);
    await receive(harness, trigger);
    const sentBefore = harness.gateway.sent.length;
    await receive(harness, trigger, trigger);
    expect(harness.gateway.sent).toHaveLength(sentBefore);
    expect(harness.notes).toEqual([]);
  });

  it("fails loudly on an unregistered platform, keeping the event for later", async () => {
    const harness = createHarness();
    const stray = { ...comment(harness), platform: "unknown" } as InboundEvent;
    await harness.store.appendEvents([stray]);
    await expect(harness.engine.dispatchNext()).rejects.toThrow("No platform registered");
    harness.clock.advance(HOUR);
    expect((await harness.store.claimEvent(harness.clock.now(), 1))?.eventId).toBe(stray.eventId);
  });
});

describe("sending", () => {
  const started = async (harness: Harness, event = comment(harness)) => {
    await harness.store.appendEvents([event]);
    while (await harness.engine.dispatchNext());
    return event;
  };

  it("uses a stable idempotency key across retries", async () => {
    const harness = createHarness();
    harness.gateway.failNext("ambiguous");
    const event = await started(harness);
    await harness.engine.sendEffects(10);
    harness.clock.advance(HOUR);
    await harness.engine.sendEffects(10);
    const [first, second] = harness.gateway.sent;
    expect(first?.key).toBe(`${runIdFor(event)}:0`);
    expect(second?.key).toBe(first?.key);
  });

  it("backs off exponentially, then delivers", async () => {
    const harness = createHarness();
    await started(harness);
    harness.gateway.failNext("transient");
    harness.gateway.failNext("transient");
    await harness.engine.sendEffects(10);
    harness.clock.advance(999);
    expect(await harness.engine.sendEffects(10)).toBe(0);
    harness.clock.advance(1);
    expect(await harness.engine.sendEffects(10)).toBe(1);
    harness.clock.advance(1_999);
    expect(await harness.engine.sendEffects(10)).toBe(0);
    harness.clock.advance(1);
    await harness.engine.sendEffects(10);
    expect(texts(harness)).toEqual(["Sent you a DM!"]);
  });

  it("honours a platform's retry-after when it's longer than the backoff", async () => {
    const harness = createHarness();
    await started(harness);
    harness.gateway.failNext("transient", 10_000);
    await harness.engine.sendEffects(10);
    harness.clock.advance(9_999);
    expect(await harness.engine.sendEffects(10)).toBe(0);
    harness.clock.advance(1);
    expect(await harness.engine.sendEffects(10)).toBe(1);
  });

  it("treats a thrown gateway error as retryable", async () => {
    const harness = createHarness();
    const event = await started(harness);
    const perform = harness.gateway.perform.bind(harness.gateway);
    let thrown = false;
    harness.gateway.perform = async (...args) => {
      if (!thrown) {
        thrown = true;
        throw new Error("socket hang up");
      }
      return perform(...args);
    };
    await harness.engine.sendEffects(10);
    const [record] = await harness.store.effects(runIdFor(event));
    expect(record).toMatchObject({ status: "queued", failures: 1 });
    expect(record?.lastError).toContain("socket hang up");
  });

  it("gives up after too many failures", async () => {
    const harness = createHarness();
    const event = await started(harness);
    for (let index = 0; index < 5; index += 1) {
      harness.gateway.failNext("transient");
      await harness.engine.sendEffects(10);
      harness.clock.advance(HOUR);
    }
    const [record] = await harness.store.effects(runIdFor(event));
    expect(record?.status).toBe("failed");
    expect(harness.notes).toMatchObject([{ tag: "effectFailed", seq: 0 }]);
  });

  it("carries on when the comment reply fails for good", async () => {
    const harness = createHarness();
    const event = await started(harness);
    harness.gateway.failNext("permanent");
    while ((await harness.engine.sendEffects(10)) > 0);
    expect((await stateOf(harness, event))?.tag).toBe("waiting");
    expect(texts(harness)).toEqual(["What's your email?"]);
  });

  it("fails the run when the ask fails for good", async () => {
    const harness = createHarness();
    const event = await started(harness);
    await harness.engine.sendEffects(10);
    harness.gateway.failNext("permanent");
    await harness.engine.sendEffects(10);
    expect(await stateOf(harness, event)).toMatchObject({ tag: "done", outcome: "failed" });
    expect(await harness.store.findActiveRun(testAccount, "alice")).toBeNull();
  });

  it("keeps a run completed and raises a note when the final link fails", async () => {
    const harness = createHarness();
    const event = comment(harness);
    await receive(harness, event);
    harness.gateway.failNext("permanent");
    await receive(harness, reply(harness, "m1", "ada@example.com"));
    expect(await stateOf(harness, event)).toMatchObject({ tag: "done", outcome: "completed" });
    expect(harness.notes).toMatchObject([{ tag: "effectFailed", seq: 2, error: "rejected" }]);
    expect((await harness.store.getContact(testAccount, "alice"))?.email).toBe("ada@example.com");
  });

  it("doesn't send past the platform's window", async () => {
    const harness = createHarness();
    const event = await started(harness);
    await harness.engine.sendEffects(10);
    harness.clock.advance(7 * DAY + 1);
    await harness.engine.sendEffects(10);
    expect(texts(harness)).toEqual(["Sent you a DM!"]);
    expect(await stateOf(harness, event)).toMatchObject({ tag: "done", outcome: "failed" });
  });
});

describe("rate limiting", () => {
  const limited: PlatformPolicy = {
    ...testPolicy,
    rateLimits: [{ action: "privateReply", max: 1, perMs: HOUR }],
  };

  const contacts = async (harness: Harness) => {
    await harness.store.appendEvents([
      comment(harness, "c1", "alice"),
      comment(harness, "c2", "bob"),
    ]);
    while (await harness.engine.dispatchNext());
    while ((await harness.engine.sendEffects(10)) > 0);
  };

  const askCount = (harness: Harness): number =>
    texts(harness).filter((text) => text === "What's your email?").length;

  it("holds a send until the limit allows it, then delivers", async () => {
    const harness = createHarness({ policy: limited });
    await contacts(harness);
    expect(askCount(harness)).toBe(1);
    harness.clock.advance(HOUR - 1);
    await harness.engine.sendEffects(10);
    expect(askCount(harness)).toBe(1);
    harness.clock.advance(1);
    await harness.engine.sendEffects(10);
    expect(askCount(harness)).toBe(2);
  });

  it("doesn't limit other action classes", async () => {
    const harness = createHarness({ policy: limited });
    await contacts(harness);
    const replies = texts(harness).filter((text) => text === "Sent you a DM!");
    expect(replies).toHaveLength(2);
  });

  it("doesn't count waiting for the limit as a failure", async () => {
    const harness = createHarness({ policy: limited });
    await contacts(harness);
    for (let index = 0; index < 10; index += 1) {
      await harness.engine.sendEffects(10);
    }
    const blocked = await harness.store.effects(
      runIdFor(comment(harness, "c2", "bob")),
    );
    expect(blocked[1]).toMatchObject({ status: "queued", failures: 0 });
  });

  it("starts the reply timeout at delivery, even after a long wait", async () => {
    const harness = createHarness({ policy: limited });
    await contacts(harness);
    harness.clock.advance(HOUR);
    await harness.engine.sendEffects(10);
    const deliveredAt = harness.clock.now();
    const bob = runIdFor(comment(harness, "c2", "bob"));
    expect((await harness.store.getRun(bob))?.state).toMatchObject({
      deadline: deliveredAt + 72 * HOUR,
    });
  });
});

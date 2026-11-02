import { describe, expect, it } from "vitest";
import {
  initialState,
  replay,
  step,
  wakeAt,
  type Input,
  type MachineConfig,
  type RunState,
} from "../src/index.ts";
import {
  DAY,
  HOUR,
  mustValidate,
  pricingComment,
  pricingConfig,
  strictPolicy,
  T0,
} from "./fixtures.ts";

const started: Input = { tag: "Started", id: "s", at: T0, comment: pricingComment };
const settled = (seq: number, at: number, ok = true): Input => ({
  tag: "EffectSettled",
  id: `settled-${seq}`,
  at,
  seq,
  ok,
});
const replied = (id: string, at: number, text: string): Input => ({ tag: "Replied", id, at, text });

const stateAfter = (...inputs: readonly Input[]): RunState =>
  replay(pricingConfig, inputs).state;

describe("the pricing flow", () => {
  it("replies and asks in order, with the DM addressed through the comment", () => {
    const { state, effects } = step(pricingConfig, initialState, started);
    expect(state.tag).toBe("waiting");
    expect(effects).toEqual([
      {
        seq: 0,
        action: { kind: "replyToComment", commentId: "comment-1", text: "Sent you a DM!" },
        onFailure: "continue",
        notAfter: null,
      },
      {
        seq: 1,
        action: {
          kind: "sendDm",
          recipient: { kind: "viaComment", commentId: "comment-1" },
          text: "What's your email?",
        },
        onFailure: "abort",
        notAfter: T0 + 7 * DAY,
      },
    ]);
  });

  it("completes on an email, sending the link inside the follow-up window", () => {
    const replyAt = T0 + HOUR;
    const { state, effects } = replay(pricingConfig, [
      started,
      replied("r1", replyAt, "sure, it's ada@example.com thanks"),
    ]);
    expect(state).toEqual({
      tag: "done",
      outcome: "completed",
      bindings: { email: "ada@example.com" },
    });
    expect(effects.at(-1)).toEqual({
      seq: 2,
      action: {
        kind: "sendDm",
        recipient: { kind: "contact", contactId: "user-1" },
        text: "Thanks ada@example.com! https://example.com/pricing",
      },
      onFailure: "abort",
      notAfter: replyAt + DAY,
    });
  });

  it("re-prompts on an invalid reply, then abandons once re-prompts run out", () => {
    const first = replay(pricingConfig, [started, replied("r1", T0 + 1, "what's the price?")]);
    expect(first.state.tag).toBe("waiting");
    expect(first.effects.at(-1)?.action).toMatchObject({
      kind: "sendDm",
      recipient: { kind: "contact", contactId: "user-1" },
    });

    const second = replay(pricingConfig, [
      started,
      replied("r1", T0 + 1, "what's the price?"),
      replied("r2", T0 + 2, "tell me"),
    ]);
    expect(second.state).toMatchObject({ tag: "done", outcome: "abandoned" });
    expect(second.effects).toHaveLength(first.effects.length);
  });
});

describe("flows with two awaits", () => {
  const twoAwaits: MachineConfig = {
    definition: mustValidate({
      trigger: { kind: "comment", keyword: "go", posts: "any" },
      entry: "askEmail",
      nodes: {
        askEmail: { kind: "sendDm", text: "Email?", onFailure: "abort", next: "waitEmail" },
        waitEmail: {
          kind: "awaitReply",
          extract: { kind: "email" },
          bindAs: "email",
          onMatch: "askBackup",
          reprompt: "Email, please?",
          maxReprompts: 1,
          onExhausted: "end",
          timeoutMs: 100,
          onTimeout: "end",
        },
        askBackup: { kind: "sendDm", text: "Backup?", onFailure: "abort", next: "waitBackup" },
        waitBackup: {
          kind: "awaitReply",
          extract: { kind: "email" },
          bindAs: "backup",
          onMatch: "end",
          reprompt: "Backup, please?",
          maxReprompts: 1,
          onExhausted: "end",
          timeoutMs: 500,
          onTimeout: "end",
        },
        end: { kind: "end", outcome: "completed" },
      },
    }),
    policy: strictPolicy,
  };

  const reachedSecond = [
    started,
    settled(0, T0),
    replied("r1", T0 + 1, "no"),
    replied("r2", T0 + 2, "ada@example.com"),
  ];

  it("moves on to the second await, with a fresh state for it", () => {
    expect(replay(twoAwaits, reachedSecond).state).toMatchObject({
      tag: "waiting",
      node: "waitBackup",
      reprompts: 0,
      timerArmedBy: 2,
      deadline: null,
    });
  });

  it("uses the second await's own timeout", () => {
    const delivered = [...reachedSecond, settled(2, T0 + 10)];
    expect(wakeAt(replay(twoAwaits, delivered).state)).toBe(T0 + 10 + 500);
  });

  it("doesn't let the first await's timer fire on the second", () => {
    const stale: Input = { tag: "TimerFired", id: "t", at: T0 + 101 };
    expect(replay(twoAwaits, [...reachedSecond, stale]).state).toMatchObject({
      tag: "waiting",
      node: "waitBackup",
    });
  });

  it("sends no second DM from a repeated timer on a path that DMs after a timeout", () => {
    // Found by the soundness law: this flow DMs for the first time after a timeout.
    const config: MachineConfig = {
      definition: mustValidate({
        trigger: { kind: "comment", keyword: "go", posts: "any" },
        entry: "first",
        nodes: {
          first: {
            kind: "awaitReply",
            extract: { kind: "email" },
            bindAs: "email",
            onMatch: "end",
            reprompt: "x",
            maxReprompts: 0,
            onExhausted: "end",
            timeoutMs: 1,
            onTimeout: "dm",
          },
          dm: { kind: "sendDm", text: "hi", onFailure: "continue", next: "second" },
          second: {
            kind: "awaitReply",
            extract: { kind: "email" },
            bindAs: "email",
            onMatch: "end",
            reprompt: "x",
            maxReprompts: 0,
            onExhausted: "end",
            timeoutMs: 1,
            onTimeout: "end",
          },
          end: { kind: "end", outcome: "abandoned" },
        },
      }),
      policy: strictPolicy,
    };
    const { effects } = replay(config, [
      started,
      { tag: "TimerFired", id: "t1", at: T0 + 1 },
      { tag: "TimerFired", id: "t2", at: T0 + 1 },
    ]);
    expect(effects).toHaveLength(1);
  });
});

describe("contact capture", () => {
  it("records the nickname when a run starts", () => {
    const comment = { ...pricingComment, authorName: "ada" };
    const transition = step(pricingConfig, initialState, { ...started, comment } as Input);
    expect(transition.contact).toEqual({ nickname: "ada" });
  });

  it("still creates the contact when the platform gives no nickname", () => {
    expect(step(pricingConfig, initialState, started).contact).toEqual({});
  });

  it("captures the email when the reply contains one", () => {
    const before = stateAfter(started);
    const { contact } = step(pricingConfig, before, replied("r1", T0 + 1, "ada@example.com"));
    expect(contact).toEqual({ email: "ada@example.com" });
  });

  it("changes nothing on the contact for an invalid reply or a timer", () => {
    const before = stateAfter(started);
    expect(step(pricingConfig, before, replied("r1", T0 + 1, "no")).contact).toBeUndefined();
    const fired: Input = { tag: "TimerFired", id: "t", at: T0 };
    expect(step(pricingConfig, before, fired).contact).toBeUndefined();
  });

  it("accumulates patches across a replay", () => {
    const comment = { ...pricingComment, authorName: "ada" };
    const { contact } = replay(pricingConfig, [
      { ...started, comment } as Input,
      replied("r1", T0 + 1, "ada@example.com"),
    ]);
    expect(contact).toEqual({ nickname: "ada", email: "ada@example.com" });
  });
});

describe("timeouts", () => {
  it("start at delivery of the ask, not when it was queued", () => {
    const backlog = 13 * HOUR;
    expect(wakeAt(stateAfter(started))).toBeNull();
    expect(wakeAt(stateAfter(started, settled(0, T0 + backlog)))).toBeNull();
    expect(wakeAt(stateAfter(started, settled(0, T0), settled(1, T0 + backlog)))).toBe(
      T0 + backlog + 72 * HOUR,
    );
  });

  it("expire the run with no reminder sent", () => {
    const fired: Input = { tag: "TimerFired", id: "t", at: T0 + 73 * HOUR };
    const { state, effects } = replay(pricingConfig, [started, settled(1, T0), fired]);
    expect(state).toMatchObject({ tag: "done", outcome: "expired" });
    expect(effects).toHaveLength(2);
  });

  it("ignore a timer that fires early", () => {
    const before = stateAfter(started, settled(1, T0));
    const early: Input = { tag: "TimerFired", id: "t", at: T0 + HOUR };
    expect(step(pricingConfig, before, early)).toEqual({ state: before, effects: [] });
  });

  it("restart when a re-prompt is delivered", () => {
    const state = stateAfter(
      started,
      settled(1, T0),
      replied("r1", T0 + HOUR, "no"),
      settled(2, T0 + 2 * HOUR),
    );
    expect(wakeAt(state)).toBe(T0 + 2 * HOUR + 72 * HOUR);
  });
});

describe("races and failures", () => {
  it("accepts a reply that arrives before the ask's delivery is confirmed", () => {
    expect(stateAfter(started, replied("r1", T0 + 1, "ada@example.com"))).toMatchObject({
      tag: "done",
      outcome: "completed",
    });
  });

  it("carries on when the comment reply fails", () => {
    expect(stateAfter(started, settled(0, T0 + 1, false)).tag).toBe("waiting");
  });

  it("fails the run when the ask fails", () => {
    expect(stateAfter(started, settled(1, T0 + 1, false))).toMatchObject({
      tag: "done",
      outcome: "failed",
    });
  });

  it("stays completed when the final link DM fails, since the email is captured", () => {
    expect(
      stateAfter(started, replied("r1", T0 + 1, "ada@example.com"), settled(2, T0 + 2, false)),
    ).toMatchObject({ tag: "done", outcome: "completed", bindings: { email: "ada@example.com" } });
  });

  it("ignores a settlement for an effect it does not know", () => {
    const before = stateAfter(started);
    expect(step(pricingConfig, before, settled(99, T0 + 1, false)).state).toEqual(before);
  });
});

import { describe, expect, it } from "vitest";
import { initialState, replay, step, wakeAt, type Input, type RunState } from "../src/index.ts";
import { DAY, HOUR, pricingComment, pricingConfig, T0 } from "./fixtures.ts";

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

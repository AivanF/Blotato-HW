import { describe, expect, it } from "vitest";
import { platformId, validate, type Definition, type FlowNode } from "../src/index.ts";
import { DAY, permissivePolicy, pricingFlow, strictTarget } from "./fixtures.ts";

const flow = (nodes: Record<string, FlowNode>, entry = "start"): Definition => ({
  trigger: { kind: "comment", keyword: "go", posts: "any" },
  entry,
  nodes,
});

const dm = (next: string, text = "hi"): FlowNode => ({
  kind: "sendDm",
  text,
  onFailure: "abort",
  next,
});

const end: FlowNode = { kind: "end", outcome: "completed" };

const wait = (targets: { onMatch: string; onExhausted?: string; onTimeout?: string }, timeoutMs = DAY / 2): FlowNode => ({
  kind: "awaitReply",
  extract: { kind: "email" },
  bindAs: "email",
  reprompt: "again?",
  maxReprompts: 1,
  timeoutMs,
  onMatch: targets.onMatch,
  onExhausted: targets.onExhausted ?? "end",
  onTimeout: targets.onTimeout ?? "end",
});

const codes = (definition: Definition, targets = [strictTarget]): readonly string[] => {
  const result = validate(definition, targets);
  return result.ok ? [] : result.errors.map((error) => error.code);
};

describe("structure", () => {
  it("accepts the pricing flow", () => {
    expect(codes(pricingFlow)).toEqual([]);
  });

  it("rejects an empty keyword", () => {
    const blank = { ...pricingFlow, trigger: { ...pricingFlow.trigger, keyword: "  " } };
    expect(codes(blank)).toEqual(["emptyKeyword"]);
  });

  it("rejects a missing entry and dangling edges", () => {
    expect(codes(flow({ end }, "nope"))).toContain("missingEntry");
    expect(codes(flow({ start: dm("nope") }))).toContain("danglingEdge");
  });

  it("does not mistake Object.prototype members for nodes", () => {
    expect(codes(flow({ start: dm("constructor") }))).toContain("danglingEdge");
  });

  it("rejects unreachable nodes", () => {
    expect(codes(flow({ start: end, orphan: end }))).toEqual(["unreachableNode"]);
  });

  it("rejects a cycle with no await, but allows one through an await", () => {
    const spin = flow({ start: { kind: "replyToComment", text: "x", onFailure: "continue", next: "start" } });
    expect(codes(spin)).toContain("cycleWithoutAwait");

    const retry = flow({
      start: dm("wait"),
      wait: wait({ onMatch: "end", onExhausted: "again" }),
      again: dm("wait"),
      end,
    });
    expect(codes(retry)).toEqual([]);
  });

  it("rejects non-positive timeouts", () => {
    const bad = flow({ start: dm("wait"), wait: wait({ onMatch: "end" }, 0), end });
    expect(codes(bad)).toContain("invalidLimit");
  });
});

describe("variables", () => {
  it("rejects a variable that is never bound", () => {
    expect(codes(flow({ start: dm("end", "{{email}}"), end }))).toEqual(["unboundVariable"]);
  });

  it("rejects a variable bound on only some paths", () => {
    const partial = flow({
      start: dm("wait"),
      wait: wait({ onMatch: "link", onExhausted: "link" }),
      link: dm("end", "{{email}}"),
      end,
    });
    expect(codes(partial)).toEqual(["unboundVariable"]);
  });

  it("accepts a variable bound on every path", () => {
    const bound = flow({
      start: dm("wait"),
      wait: wait({ onMatch: "link" }),
      link: dm("end", "{{email}}"),
      end,
    });
    expect(codes(bound)).toEqual([]);
  });
});

describe("platform policy", () => {
  it("rejects a second DM before the contact replies", () => {
    expect(codes(flow({ start: dm("second"), second: dm("end"), end }))).toEqual(["dmNotAllowed"]);
  });

  it("rejects a DM sent after a timeout, when nobody has replied", () => {
    const nudge = flow({
      start: dm("wait"),
      wait: wait({ onMatch: "end", onTimeout: "nudge" }),
      nudge: dm("end"),
      end,
    });
    expect(codes(nudge)).toEqual(["dmNotAllowed"]);
  });

  it("rejects a DM after a follow-up window has lapsed", () => {
    const late = flow({
      start: dm("first"),
      first: wait({ onMatch: "ask" }),
      ask: dm("second"),
      second: wait({ onMatch: "end", onTimeout: "tooLate" }, DAY),
      tooLate: dm("end"),
      end,
    });
    expect(codes(late)).toEqual(["dmNotAllowed"]);
  });

  it("rejects any DM from a comment on a platform that has none", () => {
    const none = {
      platform: platformId("none"),
      policy: { rateLimits: [], dmFromComment: null, followUpWindowMs: null },
    };
    expect(codes(pricingFlow, [none])).toEqual(["dmNotAllowed"]);
  });

  it("must satisfy every target, and names the platform that fails", () => {
    const twoDms = flow({ start: dm("second"), second: dm("end"), end });
    const loose = { platform: platformId("loose"), policy: permissivePolicy };
    const result = validate(twoDms, [loose, strictTarget]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.platform)).toEqual([strictTarget.platform]);
    }
  });

  it("terminates on a DM cycle through an await", () => {
    const loop = flow({
      start: dm("wait"),
      wait: wait({ onMatch: "end", onTimeout: "start" }),
      end,
    });
    expect(codes(loop)).toEqual(["dmNotAllowed"]);
  });
});

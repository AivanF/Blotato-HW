import { describe, expect, it } from "vitest";
import { parseDefinition, validate } from "../src/index.ts";
import { pricingFlow, strictTarget } from "./fixtures.ts";

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const errorsOf = (input: unknown): readonly string[] => {
  const result = parseDefinition(input);
  return result.ok ? [] : result.errors;
};

describe("parseDefinition", () => {
  it("accepts the pricing flow loaded from JSON, unchanged", () => {
    const result = parseDefinition(roundTrip(pricingFlow));
    expect(result).toEqual({ ok: true, value: pricingFlow });
    if (result.ok) expect(validate(result.value, [strictTarget]).ok).toBe(true);
  });

  it("rejects input that isn't an object", () => {
    expect(errorsOf(null)).toContain("definition must be an object");
    expect(errorsOf([])).toContain("definition must be an object");
  });

  it("rejects unknown fields, so typos aren't silently ignored", () => {
    const typo = roundTrip(pricingFlow) as { nodes: { wait: Record<string, unknown> } };
    typo.nodes.wait["timeoutMS"] = 5;
    expect(errorsOf(typo)).toContain("definition.nodes.wait.timeoutMS is not a known field");
  });

  it("names each field that has the wrong type", () => {
    const broken = roundTrip(pricingFlow) as {
      entry: unknown;
      nodes: { wait: Record<string, unknown>; ask: Record<string, unknown> };
    };
    broken.entry = 7;
    broken.nodes.wait["maxReprompts"] = -1;
    broken.nodes.wait["timeoutMs"] = 1.5;
    broken.nodes.ask["onFailure"] = "explode";
    expect(errorsOf(broken)).toEqual([
      "definition.entry must be a string",
      "definition.nodes.ask.onFailure must be one of: continue, abort",
      "definition.nodes.wait.maxReprompts must be an integer of at least 0",
      "definition.nodes.wait.timeoutMs must be an integer of at least 1",
    ]);
  });

  it("rejects an unknown node kind or extractor", () => {
    const broken = roundTrip(pricingFlow) as {
      nodes: { reply: Record<string, unknown>; wait: Record<string, unknown> };
    };
    broken.nodes.reply["kind"] = "tweet";
    broken.nodes.wait["extract"] = { kind: "phone" };
    expect(errorsOf(broken)).toEqual([
      "definition.nodes.reply.kind must be one of: replyToComment, sendDm, awaitReply, end",
      "definition.nodes.wait.extract.kind must be one of: email",
    ]);
  });

  it("checks the trigger's post list", () => {
    const broken = roundTrip(pricingFlow) as { trigger: Record<string, unknown> };
    broken.trigger["posts"] = ["p1", 2];
    expect(errorsOf(broken)).toEqual(['definition.trigger.posts must be "any" or a list of post ids']);
  });

  it("keeps a node called __proto__ as an ordinary node", () => {
    const sneaky = JSON.parse(
      '{"trigger":{"kind":"comment","keyword":"go","posts":"any"},"entry":"__proto__",' +
        '"nodes":{"__proto__":{"kind":"end","outcome":"completed"}}}',
    );
    const result = parseDefinition(sneaky);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.hasOwn(result.value.nodes, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(result.value.nodes)).toBe(Object.prototype);
    }
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  initialState,
  platformId,
  replay,
  step,
  successors,
  validate,
  type Definition,
  type FlowNode,
  type Input,
  type MachineConfig,
  type NodeId,
  type PolicyTarget,
} from "../src/index.ts";
import {
  permissivePolicy,
  pricingComment,
  pricingConfig,
  strictPolicy,
  strictTarget,
  T0,
} from "./fixtures.ts";

const NODE_COUNT = 6;
const name = (index: number): NodeId => `n${index}`;

/** Keeps the entry's reachable part, so generated definitions pass the reachability check. */
const prune = (nodes: Record<NodeId, FlowNode>): Record<NodeId, FlowNode> => {
  const kept: Record<NodeId, FlowNode> = {};
  const stack = [name(0)];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    if (!Object.hasOwn(kept, id)) {
      const node = nodes[id] as FlowNode;
      kept[id] = node;
      stack.push(...successors(node));
    }
  }
  return kept;
};

/** Non-await edges only point forward, so no cycle can avoid an await. */
const arbNode = (index: number): fc.Arbitrary<FlowNode> => {
  const anyTarget = fc.nat(NODE_COUNT - 1).map(name);
  if (index === NODE_COUNT - 1) {
    return fc.constant<FlowNode>({ kind: "end", outcome: "completed" });
  }
  const forward = fc.integer({ min: index + 1, max: NODE_COUNT - 1 }).map(name);
  const text = fc.constantFrom("hello", "hello {{email}}");
  const onFailure = fc.constantFrom("continue" as const, "abort" as const);
  return fc.oneof(
    fc.record({
      kind: fc.constant("replyToComment" as const),
      text,
      onFailure,
      next: forward,
    }),
    fc.record({ kind: fc.constant("sendDm" as const), text, onFailure, next: forward }),
    fc.record({
      kind: fc.constant("awaitReply" as const),
      extract: fc.constant({ kind: "email" as const }),
      bindAs: fc.constant("email"),
      onMatch: anyTarget,
      reprompt: text,
      maxReprompts: fc.nat(2),
      onExhausted: anyTarget,
      timeoutMs: fc.integer({ min: 1, max: 100 }),
      onTimeout: anyTarget,
    }),
    fc.constant<FlowNode>({ kind: "end", outcome: "abandoned" }),
  );
};

const arbDefinition: fc.Arbitrary<Definition> = fc
  .tuple(...Array.from({ length: NODE_COUNT }, (_, index) => arbNode(index)))
  .map((nodes) => ({
    trigger: { kind: "comment", keyword: "go", posts: "any" },
    entry: name(0),
    nodes: prune(Object.fromEntries(nodes.map((node, index) => [name(index), node]))),
  }));

type InputShape =
  | { tag: "Replied"; text: string }
  | { tag: "TimerFired" }
  | { tag: "EffectSettled"; seq: number; ok: boolean };

const arbShape: fc.Arbitrary<InputShape> = fc.oneof(
  fc.record({
    tag: fc.constant("Replied" as const),
    text: fc.constantFrom("ada@example.com", "no idea"),
  }),
  fc.record({ tag: fc.constant("TimerFired" as const) }),
  fc.record({ tag: fc.constant("EffectSettled" as const), seq: fc.nat(6), ok: fc.boolean() }),
);

/** A started run followed by arbitrary inputs, with unique ids and advancing time. */
const arbInputs: fc.Arbitrary<readonly Input[]> = fc
  .array(fc.tuple(arbShape, fc.integer({ min: 0, max: 60 })), { maxLength: 25 })
  .map((items) => {
    let at = T0;
    return [
      { tag: "Started", id: "start", at, comment: pricingComment } as const,
      ...items.map(([shape, gap], index): Input => {
        at += gap;
        return { ...shape, id: `i${index}`, at };
      }),
    ];
  });

const looseTarget: PolicyTarget = { platform: platformId("loose"), policy: permissivePolicy };

/** Definitions the validator accepts. Most rejections here are unbound `{{email}}` uses. */
const arbConfig: fc.Arbitrary<MachineConfig> = arbDefinition
  .map((definition) => validate(definition, [looseTarget]))
  .filter((result) => result.ok)
  .map((result) => ({ definition: result.definition, policy: permissivePolicy }));

describe("laws of step", () => {
  it("is total on valid definitions, and effect seqs count up from zero", () => {
    fc.assert(
      fc.property(arbConfig, arbInputs, (config, inputs) => {
        const { effects } = replay(config, inputs);
        expect(effects.map((effect) => effect.seq)).toEqual(effects.map((_, index) => index));
      }),
    );
  });

  it("treats done as absorbing", () => {
    fc.assert(
      fc.property(arbConfig, arbInputs, (config, inputs) => {
        let state = initialState;
        for (const input of inputs) {
          const next = step(config, state, input);
          if (state.tag === "done") {
            expect(next).toEqual({ state, effects: [] });
          }
          state = next.state;
        }
      }),
    );
  });

  it("is a monoid action: resuming from a stored snapshot equals one unbroken run", () => {
    fc.assert(
      fc.property(arbConfig, arbInputs, fc.nat(), (config, inputs, cut) => {
        const at = cut % (inputs.length + 1);
        const whole = replay(config, inputs);
        const head = replay(config, inputs.slice(0, at));
        const snapshot = JSON.parse(JSON.stringify(head.state));
        const tail = replay(config, inputs.slice(at), snapshot);
        expect(tail.state).toEqual(whole.state);
        expect([...head.effects, ...tail.effects]).toEqual(whole.effects);
        expect({ ...head.contact, ...tail.contact }).toEqual(whole.contact ?? {});
      }),
    );
  });

  it("is unchanged by redelivery once inputs are deduplicated by id", () => {
    fc.assert(
      fc.property(arbConfig, arbInputs, (config, inputs) => {
        const redelivered = inputs.flatMap((input) => [input, input]);
        expect(replay(config, redelivered)).toEqual(replay(config, inputs));
      }),
    );
  });

  it("holds on the pricing flow as well", () => {
    fc.assert(
      fc.property(arbInputs, (inputs) => {
        const { effects } = replay(pricingConfig, inputs);
        expect(effects.map((effect) => effect.seq)).toEqual(effects.map((_, index) => index));
      }),
    );
  });
});

describe("soundness of validation", () => {
  it("means no rendered text ever shows an unfilled placeholder", () => {
    fc.assert(
      fc.property(arbConfig, arbInputs, (config, inputs) => {
        for (const effect of replay(config, inputs).effects) {
          expect(effect.action.text).not.toContain("{{");
        }
      }),
    );
  });

  it("means a run obeys the platform policy under any inputs", () => {
    let accepted = 0;
    fc.assert(
      fc.property(arbDefinition, arbInputs, (definition, inputs) => {
        const result = validate(definition, [strictTarget]);
        if (!result.ok) return;
        accepted += 1;

        const config = { definition: result.definition, policy: strictPolicy };
        let state = initialState;
        let hasReplied = false;
        let dmsBeforeReply = 0;
        for (const input of inputs) {
          const next = step(config, state, input);
          if (input.tag === "Replied" && state.tag === "waiting") {
            hasReplied = true;
          }
          for (const { action } of next.effects) {
            if (action.kind === "sendDm" && action.recipient.kind === "viaComment") {
              dmsBeforeReply += 1;
            }
            if (action.kind === "sendDm" && action.recipient.kind === "contact") {
              expect(hasReplied).toBe(true);
            }
          }
          expect(dmsBeforeReply).toBeLessThanOrEqual(1);
          state = next.state;
        }
      }),
      { numRuns: 1000 },
    );
    expect(accepted).toBeGreaterThan(50);
  });
});

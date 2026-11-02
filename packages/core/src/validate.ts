import {
  lookupNode,
  successors,
  type Definition,
  type FlowNode,
  type NodeId,
  type ValidDefinition,
} from "./definition.ts";
import type { PlatformId, PlatformPolicy, PolicyTarget } from "./platform.ts";
import { templateVariables } from "./render.ts";

export type ValidationError = {
  readonly code:
    | "emptyKeyword"
    | "missingEntry"
    | "danglingEdge"
    | "unreachableNode"
    | "cycleWithoutAwait"
    | "invalidLimit"
    | "unboundVariable"
    | "dmNotAllowed";
  readonly message: string;
  readonly node?: NodeId;
  readonly platform?: PlatformId;
};

export type Validation =
  | { readonly ok: true; readonly definition: ValidDefinition }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/** Parses rather than checks: a `ValidDefinition` can only come from here. */
export const validate = (definition: Definition, targets: readonly PolicyTarget[]): Validation => {
  const structural = checkStructure(definition);
  const errors =
    structural.length > 0
      ? structural
      : [
          ...checkVariables(definition),
          ...targets.flatMap((target) => checkPolicy(definition, target.platform, target.policy)),
        ];
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, definition: definition as ValidDefinition };
};

const entries = (definition: Definition): readonly (readonly [NodeId, FlowNode])[] =>
  Object.entries(definition.nodes);

const checkStructure = (definition: Definition): readonly ValidationError[] => {
  const errors: ValidationError[] = [];
  if (definition.trigger.keyword.trim() === "") {
    errors.push({ code: "emptyKeyword", message: "The trigger keyword is empty." });
  }
  if (lookupNode(definition, definition.entry) === undefined) {
    errors.push({ code: "missingEntry", message: `Entry "${definition.entry}" does not exist.` });
  }
  for (const [id, node] of entries(definition)) {
    for (const target of successors(node)) {
      if (lookupNode(definition, target) === undefined) {
        errors.push({
          code: "danglingEdge",
          node: id,
          message: `"${id}" points to "${target}", which does not exist.`,
        });
      }
    }
    if (node.kind === "awaitReply" && (node.timeoutMs <= 0 || node.maxReprompts < 0)) {
      errors.push({
        code: "invalidLimit",
        node: id,
        message: `"${id}" needs a positive timeout and a non-negative reprompt count.`,
      });
    }
  }
  if (errors.length > 0) {
    return errors;
  }

  const reachable = reachableFrom(definition);
  for (const [id] of entries(definition)) {
    if (!reachable.has(id)) {
      errors.push({ code: "unreachableNode", node: id, message: `"${id}" is unreachable.` });
    }
  }
  const cycleNode = findCycleWithoutAwait(definition);
  if (cycleNode !== null) {
    errors.push({
      code: "cycleWithoutAwait",
      node: cycleNode,
      message: `"${cycleNode}" is on a cycle with no awaitReply, which would send messages forever.`,
    });
  }
  return errors;
};

const reachableFrom = (definition: Definition): ReadonlySet<NodeId> => {
  const seen = new Set<NodeId>();
  const stack = [definition.entry];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    if (!seen.has(id)) {
      seen.add(id);
      stack.push(...successors(lookupNode(definition, id) as FlowNode));
    }
  }
  return seen;
};

/** With edges out of `awaitReply` removed the graph must be acyclic, so `step` always stops. */
const findCycleWithoutAwait = (definition: Definition): NodeId | null => {
  const done = new Set<NodeId>();
  const onPath = new Set<NodeId>();
  const visit = (id: NodeId): NodeId | null => {
    if (onPath.has(id)) return id;
    if (done.has(id)) return null;
    const node = lookupNode(definition, id) as FlowNode;
    onPath.add(id);
    for (const next of node.kind === "awaitReply" ? [] : successors(node)) {
      const found = visit(next);
      if (found !== null) return found;
    }
    onPath.delete(id);
    done.add(id);
    return null;
  };
  for (const [id] of entries(definition)) {
    const found = visit(id);
    if (found !== null) return found;
  }
  return null;
};

type Semilattice<V> = {
  readonly join: (a: V, b: V) => V;
  readonly equals: (a: V, b: V) => boolean;
};

/**
 * Forward dataflow to a fixed point. Both analyses below are instances of it, and terminate
 * because each has a finite lattice and a monotone transfer function.
 */
const forwardFlow = <V>(
  definition: Definition,
  initial: V,
  lattice: Semilattice<V>,
  transfer: (node: FlowNode, input: V) => readonly (readonly [NodeId, V])[],
): ReadonlyMap<NodeId, V> => {
  const facts = new Map<NodeId, V>([[definition.entry, initial]]);
  const worklist = [definition.entry];
  while (worklist.length > 0) {
    const id = worklist.pop() as NodeId;
    for (const [target, output] of transfer(
      lookupNode(definition, id) as FlowNode,
      facts.get(id) as V,
    )) {
      const current = facts.get(target);
      const next = current === undefined ? output : lattice.join(current, output);
      if (current === undefined || !lattice.equals(current, next)) {
        facts.set(target, next);
        worklist.push(target);
      }
    }
  }
  return facts;
};

const nodeTemplates = (node: FlowNode): readonly string[] => {
  switch (node.kind) {
    case "replyToComment":
    case "sendDm":
      return [node.text];
    case "awaitReply":
      return [node.reprompt];
    case "end":
      return [];
  }
};

/** A must-analysis: a variable counts as bound only if every path to the node binds it. */
const checkVariables = (definition: Definition): readonly ValidationError[] => {
  const bound = forwardFlow<ReadonlySet<string>>(
    definition,
    new Set(),
    {
      join: (a, b) => new Set([...a].filter((name) => b.has(name))),
      equals: (a, b) => a.size === b.size && [...a].every((name) => b.has(name)),
    },
    (node, input) =>
      node.kind === "awaitReply"
        ? [
            [node.onMatch, new Set([...input, node.bindAs])],
            [node.onExhausted, input],
            [node.onTimeout, input],
          ]
        : successors(node).map((target) => [target, input] as const),
  );
  return entries(definition).flatMap(([id, node]) =>
    nodeTemplates(node)
      .flatMap(templateVariables)
      .filter((name) => !bound.get(id)?.has(name))
      .map((name) => ({
        code: "unboundVariable" as const,
        node: id,
        message: `"${id}" uses {{${name}}}, which is not bound on every path to it.`,
      })),
  );
};

/**
 * What may still be sent, ordered worst-last: a window opened by a reply, then the number of
 * DMs already used on a commenter who has not replied, then a window that has closed.
 */
const WINDOW_OPEN = -1;
const WINDOW_CLOSED = Number.POSITIVE_INFINITY;

const checkPolicy = (
  definition: Definition,
  platform: PlatformId,
  policy: PlatformPolicy,
): readonly ValidationError[] => {
  const budget = policy.dmFromComment?.maxMessages ?? 0;
  const window = policy.followUpWindowMs;

  const allowance = forwardFlow<number>(
    definition,
    0,
    { join: Math.max, equals: (a, b) => a === b },
    (node, input) => {
      switch (node.kind) {
        case "replyToComment":
          return [[node.next, input]];
        case "sendDm":
          // Saturates at the budget: the overrun is reported below, and the lattice stays finite.
          return [
            [
              node.next,
              input === WINDOW_OPEN || input === WINDOW_CLOSED
                ? input
                : Math.min(input + 1, budget),
            ],
          ];
        case "awaitReply": {
          const expires = window !== null && node.timeoutMs >= window;
          return [
            [node.onMatch, WINDOW_OPEN],
            [node.onExhausted, WINDOW_OPEN],
            [node.onTimeout, input === WINDOW_OPEN && expires ? WINDOW_CLOSED : input],
          ];
        }
        case "end":
          return [];
      }
    },
  );

  return entries(definition).flatMap(([id, node]): readonly ValidationError[] => {
    if (node.kind !== "sendDm") return [];
    const before = allowance.get(id) as number;
    if (before === WINDOW_CLOSED) {
      return [
        {
          code: "dmNotAllowed",
          node: id,
          platform,
          message: `"${id}" can send after the follow-up window on ${platform} has closed.`,
        },
      ];
    }
    if (before !== WINDOW_OPEN && before >= budget) {
      return [
        {
          code: "dmNotAllowed",
          node: id,
          platform,
          message: `"${id}" can exceed ${budget} DM(s) before the contact replies on ${platform}.`,
        },
      ];
    }
    return [];
  });
};

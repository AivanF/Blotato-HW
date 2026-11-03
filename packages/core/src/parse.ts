import type { Definition, FlowNode, Trigger } from "./definition.ts";

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type Fields = Readonly<Record<string, unknown>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks the shape of a definition loaded from JSON, before `validate` checks its meaning.
 * Unknown fields are rejected, so a typo like "timeoutMS" can't be silently ignored.
 */
export const parseDefinition = (input: unknown): Parsed<Definition> => {
  const errors: string[] = [];

  const fail = (path: string, message: string): undefined => {
    errors.push(`${path} ${message}`);
    return undefined;
  };
  const fields = (path: string, value: unknown, known: readonly string[]): Fields => {
    if (!isFields(value)) {
      fail(path, "must be an object");
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) fail(`${path}.${key}`, "is not a known field");
    }
    return value;
  };
  const string = (path: string, value: unknown): string | undefined =>
    typeof value === "string" ? value : fail(path, "must be a string");
  const integer = (path: string, value: unknown, min: number): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min
      ? value
      : fail(path, `must be an integer of at least ${min}`);
  const oneOf = <T extends string>(path: string, value: unknown, options: readonly T[]) =>
    options.includes(value as T) ? (value as T) : fail(path, `must be one of: ${options.join(", ")}`);

  const trigger = (path: string, value: unknown): Trigger => {
    const raw = fields(path, value, ["kind", "keyword", "posts"]);
    const posts =
      raw["posts"] === "any"
        ? "any"
        : Array.isArray(raw["posts"]) && raw["posts"].every((post) => typeof post === "string")
          ? (raw["posts"] as string[])
          : fail(`${path}.posts`, `must be "any" or a list of post ids`);
    return {
      kind: oneOf(`${path}.kind`, raw["kind"], ["comment"] as const),
      keyword: string(`${path}.keyword`, raw["keyword"]),
      posts,
    } as Trigger;
  };

  const node = (path: string, value: unknown): FlowNode => {
    const kind = isFields(value) ? value["kind"] : undefined;
    switch (kind) {
      case "replyToComment":
      case "sendDm": {
        const raw = fields(path, value, ["kind", "text", "onFailure", "next"]);
        return {
          kind,
          text: string(`${path}.text`, raw["text"]),
          onFailure: oneOf(`${path}.onFailure`, raw["onFailure"], ["continue", "abort"] as const),
          next: string(`${path}.next`, raw["next"]),
        } as FlowNode;
      }
      case "awaitReply": {
        const known = [
          "kind",
          "extract",
          "bindAs",
          "onMatch",
          "reprompt",
          "maxReprompts",
          "onExhausted",
          "timeoutMs",
          "onTimeout",
        ];
        const raw = fields(path, value, known);
        const extract = fields(`${path}.extract`, raw["extract"], ["kind"]);
        return {
          kind,
          extract: { kind: oneOf(`${path}.extract.kind`, extract["kind"], ["email"] as const) },
          bindAs: string(`${path}.bindAs`, raw["bindAs"]),
          onMatch: string(`${path}.onMatch`, raw["onMatch"]),
          reprompt: string(`${path}.reprompt`, raw["reprompt"]),
          maxReprompts: integer(`${path}.maxReprompts`, raw["maxReprompts"], 0),
          onExhausted: string(`${path}.onExhausted`, raw["onExhausted"]),
          timeoutMs: integer(`${path}.timeoutMs`, raw["timeoutMs"], 1),
          onTimeout: string(`${path}.onTimeout`, raw["onTimeout"]),
        } as FlowNode;
      }
      case "end": {
        const raw = fields(path, value, ["kind", "outcome"]);
        return {
          kind,
          outcome: oneOf(`${path}.outcome`, raw["outcome"], [
            "completed",
            "abandoned",
            "expired",
          ] as const),
        } as FlowNode;
      }
      default:
        fail(`${path}.kind`, "must be one of: replyToComment, sendDm, awaitReply, end");
        return { kind: "end", outcome: "completed" };
    }
  };

  const raw = fields("definition", input, ["trigger", "entry", "nodes"]);
  const nodes = fields("definition.nodes", raw["nodes"], Object.keys(raw["nodes"] ?? {}));
  const definition = {
    trigger: trigger("definition.trigger", raw["trigger"]),
    entry: string("definition.entry", raw["entry"]),
    // fromEntries makes "__proto__" an ordinary key instead of changing the prototype.
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, value]) => [id, node(`definition.nodes.${id}`, value)]),
    ),
  } as Definition;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: definition };
};

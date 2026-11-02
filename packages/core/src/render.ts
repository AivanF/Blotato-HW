import type { Template } from "./definition.ts";

export type Bindings = Readonly<Record<string, string>>;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

export const templateVariables = (template: Template): readonly string[] =>
  [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);

/** A single pass, so a bound value containing `{{x}}` is never expanded. */
export const render = (template: Template, bindings: Bindings): string =>
  template.replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.hasOwn(bindings, name) ? (bindings[name] as string) : placeholder,
  );

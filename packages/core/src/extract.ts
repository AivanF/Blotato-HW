import type { ExtractorSpec } from "./definition.ts";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** Finds the value in free text, so "sure, it's a@b.co thanks" works. */
export const extract = (spec: ExtractorSpec, text: string): string | null => {
  switch (spec.kind) {
    case "email":
      return EMAIL.exec(text)?.[0] ?? null;
  }
};

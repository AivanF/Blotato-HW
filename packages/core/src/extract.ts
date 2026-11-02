import type { ExtractorSpec } from "./definition.ts";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** Changes to a contact. A missing field leaves the stored value alone. */
export type ContactPatch = {
  readonly nickname?: string;
  readonly email?: string;
};

/** Which contact field an extracted value belongs to. */
export const contactPatchFor = (spec: ExtractorSpec, value: string): ContactPatch => {
  switch (spec.kind) {
    case "email":
      return { email: value };
  }
};

/** Finds the value in free text, so "sure, it's a@b.co thanks" works. */
export const extract = (spec: ExtractorSpec, text: string): string | null => {
  switch (spec.kind) {
    case "email":
      return EMAIL.exec(text)?.[0] ?? null;
  }
};

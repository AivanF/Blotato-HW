import { describe, expect, it } from "vitest";
import { containsKeyword, extract, render, selectAutomation, type Trigger } from "../src/index.ts";
import { pricingComment } from "./fixtures.ts";

describe("extract", () => {
  it.each([
    ["ada@example.com", "ada@example.com"],
    ["sure, it's ada.l+x@mail.example.co.uk thanks", "ada.l+x@mail.example.co.uk"],
    ["ada@example.com.", "ada@example.com"],
    ["no email here", null],
    ["ada@example", null],
    ["@example.com", null],
  ])("%s → %s", (text, expected) => {
    expect(extract({ kind: "email" }, text)).toBe(expected);
  });
});

describe("render", () => {
  it("fills placeholders", () => {
    expect(render("Hi {{ name }}, {{name}}!", { name: "Ada" })).toBe("Hi Ada, Ada!");
  });

  it("never expands a placeholder inside a value", () => {
    expect(render("{{a}}", { a: "{{b}}", b: "secret" })).toBe("{{b}}");
  });

  it("does not read Object.prototype", () => {
    expect(render("{{constructor}}", {})).toBe("{{constructor}}");
  });
});

describe("containsKeyword", () => {
  it.each([
    ["pricing", true],
    ["PRICING?", true],
    ["what's the pricing, please", true],
    ["repricing", false],
    ["pricings", false],
    ["ｐｒｉｃｉｎｇ", true],
    ["", false],
  ])("%s → %s", (text, expected) => {
    expect(containsKeyword(text, "pricing")).toBe(expected);
  });

  it("treats regex characters in a keyword literally", () => {
    expect(containsKeyword("a.b", "a.b")).toBe(true);
    expect(containsKeyword("axb", "a.b")).toBe(false);
  });
});

describe("selectAutomation", () => {
  const anyPost: Trigger = { kind: "comment", keyword: "pricing", posts: "any" };
  const first = { name: "first", trigger: anyPost };
  const second = { name: "second", trigger: anyPost };
  const otherPost = { name: "other", trigger: { ...anyPost, posts: ["post-9"] } };

  it("takes the first match in priority order", () => {
    expect(selectAutomation([otherPost, first, second], pricingComment, "me")).toBe(first);
  });

  it("returns null when nothing matches", () => {
    expect(selectAutomation([otherPost], pricingComment, "me")).toBeNull();
  });

  it("ignores the account's own comments, which stops reply loops", () => {
    expect(selectAutomation([first], pricingComment, pricingComment.authorId)).toBeNull();
  });
});

import { readFile } from "node:fs/promises";
import { FAKE_PLATFORM, fakePolicy } from "@automations/platform-fake";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/catalog.ts";

const policies = new Map([[FAKE_PLATFORM, fakePolicy]]);
const shipped = async () =>
  JSON.parse(await readFile(new URL("../automations.json", import.meta.url), "utf8"));

describe("loadCatalog", () => {
  it("loads the shipped automations file", async () => {
    const catalog = loadCatalog(await shipped(), policies);
    const account = await catalog.forAccount({ platform: FAKE_PLATFORM, accountId: "acme" });
    expect(account.selfAuthorId).toBe("acme");
    expect(account.automations.map((entry) => entry.versionId)).toEqual(["pricing-v1"]);
    expect(await catalog.definition("pricing-v1")).not.toBeNull();
  });

  it("knows no automations for an unknown account", async () => {
    const catalog = loadCatalog(await shipped(), policies);
    const account = await catalog.forAccount({ platform: FAKE_PLATFORM, accountId: "nobody" });
    expect(account.automations).toEqual([]);
  });

  it("lists every problem at once", async () => {
    const file = await shipped();
    const [account] = file.accounts;
    account.automations.push({ ...account.automations[0] });
    account.automations.push({
      versionId: "broken",
      definition: { ...account.automations[0].definition, entry: 7 },
    });
    file.accounts.push({ platform: "myspace", accountId: "old", selfAuthorId: "x", automations: [] });
    expect(() => loadCatalog(file, policies)).toThrow(
      [
        "The automations file has problems:",
        "Account acme, automation pricing-v1: the version id is used twice.",
        "Account acme, automation broken: definition.entry must be a string",
        'Account old: unknown platform "myspace".',
      ].join("\n"),
    );
  });

  it("rejects a flow the platform's rules forbid", async () => {
    const file = await shipped();
    const { nodes } = file.accounts[0].automations[0].definition;
    nodes.reply = { kind: "sendDm", text: "One", onFailure: "continue", next: "ask" };
    expect(() => loadCatalog(file, policies)).toThrow("can exceed 1 DM(s)");
  });
});

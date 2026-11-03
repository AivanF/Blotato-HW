import {
  parseDefinition,
  platformId,
  validate,
  type AccountRef,
  type AutomationCatalog,
  type CatalogEntry,
  type PlatformId,
  type PlatformPolicy,
  type ValidDefinition,
} from "@automations/core";

/**
 * Automations from a JSON file, standing in for the designed `automations` tables. The file
 * lists accounts, each with its own user ID and its automations in priority order.
 */
type CatalogFile = {
  readonly accounts: readonly {
    readonly platform: string;
    readonly accountId: string;
    readonly selfAuthorId: string;
    readonly automations: readonly { readonly versionId: string; readonly definition: unknown }[];
  }[];
};

const accountKey = (account: AccountRef): string =>
  JSON.stringify([account.platform, account.accountId]);

/** Fails at startup with every problem listed, rather than at the first comment. */
export const loadCatalog = (
  file: unknown,
  policies: ReadonlyMap<PlatformId, PlatformPolicy>,
): AutomationCatalog => {
  const errors: string[] = [];
  const accounts = new Map<string, { selfAuthorId: string; automations: CatalogEntry[] }>();
  const versions = new Map<string, ValidDefinition>();

  for (const account of (file as CatalogFile)?.accounts ?? []) {
    const platform = platformId(account.platform);
    const policy = policies.get(platform);
    if (policy === undefined) {
      errors.push(`Account ${account.accountId}: unknown platform "${account.platform}".`);
      continue;
    }
    const entries: CatalogEntry[] = [];
    for (const { versionId, definition } of account.automations) {
      const where = `Account ${account.accountId}, automation ${versionId}`;
      if (versions.has(versionId)) {
        errors.push(`${where}: the version id is used twice.`);
        continue;
      }
      const parsed = parseDefinition(definition);
      if (!parsed.ok) {
        errors.push(...parsed.errors.map((error) => `${where}: ${error}`));
        continue;
      }
      const validated = validate(parsed.value, [{ platform, policy }]);
      if (!validated.ok) {
        errors.push(...validated.errors.map((error) => `${where}: ${error.message}`));
        continue;
      }
      versions.set(versionId, validated.definition);
      entries.push({ versionId, trigger: validated.definition.trigger });
    }
    accounts.set(accountKey({ platform, accountId: account.accountId }), {
      selfAuthorId: account.selfAuthorId,
      automations: entries,
    });
  }

  if (errors.length > 0) {
    throw new Error(`The automations file has problems:\n${errors.join("\n")}`);
  }
  return {
    forAccount: async (account) =>
      accounts.get(accountKey(account)) ?? { selfAuthorId: "", automations: [] },
    definition: async (versionId) => versions.get(versionId) ?? null,
  };
};

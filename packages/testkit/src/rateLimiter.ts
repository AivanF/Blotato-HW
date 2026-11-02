import type { AccountRef, RateLimiter, RateLimit } from "@automations/core";
import { describe, expect, it } from "vitest";
import { platformId } from "@automations/core";

/** A sliding log rather than a token bucket, which could allow twice the limit in one window. */
export const createMemoryRateLimiter = (): RateLimiter => {
  const logs = new Map<string, number[]>();
  return {
    async acquire(account, limit, now) {
      const key = JSON.stringify([account.platform, account.accountId, limit.action]);
      const log = (logs.get(key) ?? []).filter((at) => at > now - limit.perMs);
      logs.set(key, log);
      const oldest = log[0];
      if (log.length >= limit.max && oldest !== undefined) {
        return { tag: "denied", retryAt: oldest + limit.perMs };
      }
      log.push(now);
      return { tag: "granted" };
    },
  };
};

const account: AccountRef = { platform: platformId("test"), accountId: "account-1" };
const limit: RateLimit = { action: "directMessage", max: 2, perMs: 100 };

/** The rules every limiter adapter must follow. */
export const describeRateLimiter = (name: string, create: () => Promise<RateLimiter>): void => {
  describe(`RateLimiter contract: ${name}`, () => {
    it("grants up to the limit, then denies", async () => {
      const limiter = await create();
      expect((await limiter.acquire(account, limit, 0)).tag).toBe("granted");
      expect((await limiter.acquire(account, limit, 0)).tag).toBe("granted");
      expect((await limiter.acquire(account, limit, 0)).tag).toBe("denied");
    });

    it("gives a retry time at which a grant succeeds", async () => {
      const limiter = await create();
      await limiter.acquire(account, limit, 0);
      await limiter.acquire(account, limit, 10);
      const decision = await limiter.acquire(account, limit, 20);
      expect(decision).toEqual({ tag: "denied", retryAt: 100 });
      expect((await limiter.acquire(account, limit, 99)).tag).toBe("denied");
      expect((await limiter.acquire(account, limit, 100)).tag).toBe("granted");
    });

    it("never exceeds the limit in any window, even across a window boundary", async () => {
      const limiter = await create();
      const granted: number[] = [];
      for (let now = 0; now < 1_000; now += 7) {
        if ((await limiter.acquire(account, limit, now)).tag === "granted") {
          granted.push(now);
        }
      }
      for (const at of granted) {
        const inWindow = granted.filter((other) => other > at - limit.perMs && other <= at);
        expect(inWindow.length).toBeLessThanOrEqual(limit.max);
      }
      expect(granted.length).toBeGreaterThan(limit.max);
    });

    it("keeps accounts and action classes separate", async () => {
      const limiter = await create();
      const one = { ...limit, max: 1 };
      await limiter.acquire(account, one, 0);
      expect((await limiter.acquire(account, one, 0)).tag).toBe("denied");
      expect(
        (await limiter.acquire({ ...account, accountId: "account-2" }, one, 0)).tag,
      ).toBe("granted");
      expect(
        (await limiter.acquire({ ...account, platform: platformId("other") }, one, 0)).tag,
      ).toBe("granted");
      expect((await limiter.acquire(account, { ...one, action: "privateReply" }, 0)).tag).toBe(
        "granted",
      );
    });

    it("grants no more than the limit to concurrent callers", async () => {
      const limiter = await create();
      const results = await Promise.all(
        Array.from({ length: 16 }, () => limiter.acquire(account, limit, 0)),
      );
      expect(results.filter((result) => result.tag === "granted")).toHaveLength(limit.max);
    });
  });
};

import type { Engine } from "@automations/core";
import { describe, expect, it } from "vitest";
import { runWorkers } from "../src/workers.ts";

const waitFor = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const options = (signal: AbortSignal, errors: unknown[]) => ({
  dispatchers: 1,
  senders: 1,
  pollMs: 1,
  batch: 10,
  signal,
  onError: (error: unknown) => errors.push(error),
});

describe("runWorkers", () => {
  it("keeps a loop running after a step throws, and reports the error", async () => {
    let calls = 0;
    const engine: Engine = {
      dispatchNext: async () => {
        calls += 1;
        if (calls === 1) throw new Error("database blip");
        return false;
      },
      sendEffects: async () => 0,
      fireTimers: async () => 0,
    };
    const stop = new AbortController();
    const errors: unknown[] = [];
    const running = runWorkers(engine, options(stop.signal, errors));
    await waitFor(() => calls >= 3);
    stop.abort();
    await running;
    expect(errors).toHaveLength(1);
  });

  it("works through a backlog without pausing, and stops when aborted", async () => {
    let backlog = 50;
    let idleCalls = 0;
    const engine: Engine = {
      dispatchNext: async () => {
        if (backlog > 0) {
          backlog -= 1;
          return true;
        }
        idleCalls += 1;
        return false;
      },
      sendEffects: async () => 0,
      fireTimers: async () => 0,
    };
    const stop = new AbortController();
    const running = runWorkers(engine, { ...options(stop.signal, []), pollMs: 60_000 });
    await waitFor(() => backlog === 0 && idleCalls === 1);
    stop.abort();
    await running;
  });
});

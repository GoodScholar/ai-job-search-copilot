import { afterEach, describe, expect, it, vi } from "vitest";
import { closeWithinDeadline } from "./close-within-deadline.js";

afterEach(() => vi.useRealTimers());

describe("closeWithinDeadline", () => {
  it("clears its timer when close resolves or rejects", async () => {
    vi.useFakeTimers();
    await expect(closeWithinDeadline(Promise.resolve(), "close deadline")).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await expect(closeWithinDeadline(Promise.reject(new Error("close rejected")), "close deadline")).rejects.toThrow("close rejected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at the shared deadline", async () => {
    vi.useFakeTimers();
    const closing = closeWithinDeadline(new Promise<void>(() => undefined), "close deadline");
    const settled = closing.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(settled).resolves.toMatchObject({ message: "close deadline" });
  });
});

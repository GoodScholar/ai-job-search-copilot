import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisHeartbeatAdapter } from "./redis-heartbeat.adapter.js";

function redisDouble(input: { quit: () => Promise<void> }) {
  return {
    status: "ready",
    quit: vi.fn(input.quit),
    disconnect: vi.fn(),
  };
}

afterEach(() => vi.useRealTimers());

describe("RedisHeartbeatAdapter close", () => {
  it("quit 超时后 disconnect，并且重复 close 不启动第二轮", async () => {
    vi.useFakeTimers();
    const redis = redisDouble({ quit: () => new Promise<void>(() => undefined) });
    const heartbeat = new RedisHeartbeatAdapter(redis as never);
    const closing = heartbeat.close();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    await expect(closing).resolves.toBeUndefined();
    await heartbeat.close();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it("quit 拒绝后仍 disconnect，且 Nest hook 不拒绝", async () => {
    const redis = redisDouble({ quit: async () => { throw new Error("redis unavailable"); } });
    const heartbeat = new RedisHeartbeatAdapter(redis as never);

    await expect(heartbeat.onModuleDestroy()).resolves.toBeUndefined();
    await heartbeat.onModuleDestroy();

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});

import Redis from "ioredis";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisHeartbeatAdapter } from "./redis-heartbeat.adapter.js";

describe("RedisHeartbeatAdapter", () => {
  let container: StartedRedisContainer;
  let heartbeat: RedisHeartbeatAdapter;

  beforeAll(async () => {
    container = await new RedisContainer("redis:7-alpine").start();
    heartbeat = new RedisHeartbeatAdapter(new Redis(container.getConnectionUrl()));
  }, 60_000);

  afterAll(async () => {
    await heartbeat?.close();
    await container?.stop();
  });

  it("returns a heartbeat only inside the ten-second freshness window", async () => {
    await heartbeat.write({
      workerId: "worker-test",
      recordedAt: "2026-08-26T10:00:00.000Z",
      contractVersion: 1,
    });

    await expect(heartbeat.readFresh(new Date("2026-08-26T10:00:04.000Z"))).resolves.toEqual({
      workerId: "worker-test",
      recordedAt: "2026-08-26T10:00:00.000Z",
      contractVersion: 1,
    });
    await expect(heartbeat.readFresh(new Date("2026-08-26T10:00:11.000Z"))).resolves.toBeNull();
  });
});

import Redis from "ioredis";
import { NestFactory } from "@nestjs/core";
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

  it("Nest context 关闭时释放 heartbeat 的 Redis owner 一次", async () => {
    const closed: string[] = [];
    const lifecycleHeartbeat = Object.create(RedisHeartbeatAdapter.prototype) as RedisHeartbeatAdapter;
    Object.assign(lifecycleHeartbeat as object, {
      redis: {
        status: "ready",
        quit: async () => { closed.push("redis"); },
      },
    });
    const context = await NestFactory.createApplicationContext({
      module: class LifecycleTestModule {},
      providers: [{ provide: RedisHeartbeatAdapter, useValue: lifecycleHeartbeat }],
    }, { logger: false });

    await context.close();
    await context.close();

    expect(closed).toEqual(["redis"]);
  });
});

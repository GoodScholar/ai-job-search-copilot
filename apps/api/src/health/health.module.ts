import { Module } from "@nestjs/common";
import { DATABASE, RuntimeConfigModule } from "../config/runtime-config.module.js";
import type { Database } from "@job-copilot/database";
import { Client as MinioClient } from "minio";
import Redis from "ioredis";
import { HealthController } from "./health.controller.js";
import { readFreshHeartbeat, READINESS_CHECKS, type ReadinessDependencies } from "./readiness.js";

function getRuntimeUrl(name: string, fallback: string): URL {
  return new URL(process.env[name] ?? fallback);
}

function createMinioClient(): MinioClient {
  const endpoint = getRuntimeUrl(
    "MINIO_ENDPOINT",
    `http://127.0.0.1:${process.env.MINIO_API_PORT ?? "59000"}`,
  );
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "job_copilot",
    secretKey: process.env.MINIO_SECRET_KEY ?? "local_only_job_copilot_secret",
  });
}

async function withRedis<T>(action: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = new Redis(
    process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`,
    { connectTimeout: 1_000, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null },
  );
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    return await action(redis);
  } finally {
    redis.disconnect();
  }
}

function createReadinessChecks(database: Database): ReadinessDependencies {
  return {
    postgres: async () => {
      await database.$client`select 1`;
      return true;
    },
    redis: async () => withRedis(async (redis) => (await redis.ping()) === "PONG"),
    minio: async () => {
      const endpoint = getRuntimeUrl(
        "MINIO_ENDPOINT",
        `http://127.0.0.1:${process.env.MINIO_API_PORT ?? "59000"}`,
      );
      const health = await fetch(new URL("/minio/health/live", endpoint), { signal: AbortSignal.timeout(1_000) });
      return health.ok && createMinioClient().bucketExists("career-documents");
    },
    mailpit: async () => {
      const endpoint = getRuntimeUrl(
        "MAILPIT_ENDPOINT",
        `http://127.0.0.1:${process.env.MAILPIT_HTTP_PORT ?? "58025"}`,
      );
      const health = await fetch(new URL("/readyz", endpoint), { signal: AbortSignal.timeout(1_000) });
      return health.ok;
    },
    worker: async () => withRedis(async (redis) => {
      const heartbeat = await readFreshHeartbeat({ redis, now: new Date() });
      return heartbeat !== null;
    }),
  };
}

@Module({
  imports: [RuntimeConfigModule],
  controllers: [HealthController],
  providers: [{
    provide: READINESS_CHECKS,
    inject: [DATABASE],
    useFactory: (database: Database) => createReadinessChecks(database),
  }],
})
export class HealthModule {}

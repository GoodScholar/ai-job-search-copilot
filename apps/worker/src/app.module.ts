import { Module } from "@nestjs/common";
import Redis from "ioredis";
import { CareerImportModule } from "./career-import/career-import.module.js";
import { RedisHeartbeatAdapter } from "./heartbeat/redis-heartbeat.adapter.js";

export const WORKER_HEARTBEAT = Symbol("WORKER_HEARTBEAT");

function getRedisUrl(): string {
  return process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`;
}

@Module({
  imports: [CareerImportModule],
  providers: [
    {
      provide: WORKER_HEARTBEAT,
      useFactory: () => new RedisHeartbeatAdapter(new Redis(getRedisUrl())),
    },
  ],
  exports: [WORKER_HEARTBEAT],
})
export class AppModule {}

import "reflect-metadata";
import { hostname } from "node:os";
import { NestFactory } from "@nestjs/core";
import { AppModule, WORKER_HEARTBEAT } from "./app.module.js";
import { CAREER_IMPORT_CONSUMER } from "./career-import/career-import.module.js";
import type { CareerImportConsumer } from "./career-import/career-import-consumer.js";
import type { Heartbeat } from "./heartbeat/heartbeat.js";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const heartbeat = app.get<Heartbeat>(WORKER_HEARTBEAT);
  const careerImportConsumer = app.get<CareerImportConsumer>(CAREER_IMPORT_CONSUMER);
  const workerId = process.env.WORKER_ID ?? `worker-${hostname()}-${process.pid}`;
  const refreshHeartbeat = async () => heartbeat.write({
    workerId,
    recordedAt: new Date().toISOString(),
    contractVersion: 1,
  });

  await refreshHeartbeat();
  const heartbeatTimer = setInterval(() => {
    void refreshHeartbeat().catch((error: unknown) => console.error("Worker heartbeat refresh failed", error));
  }, 5_000);
  const shutdown = async () => {
    clearInterval(heartbeatTimer);
    await careerImportConsumer.close();
    await heartbeat.close();
    await app.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void bootstrap();

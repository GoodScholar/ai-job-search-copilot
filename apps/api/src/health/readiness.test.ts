import "reflect-metadata";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadinessResponseSchema, RuntimeNotReadyProblemSchema } from "@job-copilot/contracts/runtime";
import { ApiProblemFilter } from "../common/api-problem.filter.js";
import { RequestIdHook } from "../common/request-id.hook.js";
import { configureOpenApi } from "../api-documentation.js";
import { HealthController } from "./health.controller.js";
import { checkReadiness, READINESS_CHECKS, type ReadinessDependencies } from "./readiness.js";

describe("checkReadiness", () => {
  it("reports every dependency instead of hiding a partial outage", async () => {
    const result = await checkReadiness({
      postgres: async () => true,
      redis: async () => true,
      minio: async () => false,
      mailpit: async () => true,
      worker: async () => false,
    });

    expect(result).toEqual({
      status: "not_ready",
      dependencies: {
        postgres: "ready",
        redis: "ready",
        minio: "not_ready",
        mailpit: "ready",
        worker: "not_ready",
      },
    });
  });

  it("marks only a throwing dependency as not ready", async () => {
    const result = await checkReadiness({
      postgres: async () => true,
      redis: async () => { throw new Error("redis://credential@internal"); },
      minio: async () => true,
      mailpit: async () => true,
      worker: async () => true,
    });

    expect(result).toEqual({
      status: "not_ready",
      dependencies: {
        postgres: "ready",
        redis: "not_ready",
        minio: "ready",
        mailpit: "ready",
        worker: "ready",
      },
    });
  });
});

describe("GET /health/ready", () => {
  let app: NestFastifyApplication;
  const readinessChecks: ReadinessDependencies = {
    postgres: async () => true,
    redis: async () => true,
    minio: async () => false,
    mailpit: async () => true,
    worker: async () => false,
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        RequestIdHook,
        { provide: READINESS_CHECKS, useValue: readinessChecks },
        { provide: APP_FILTER, useClass: ApiProblemFilter },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureOpenApi(app);
    await app.init();
  });

  afterAll(async () => app?.close());

  it("returns dependency statuses in a 503 problem", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(RuntimeNotReadyProblemSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toEqual({
      code: "RUNTIME_NOT_READY",
      message: "运行依赖未就绪",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      dependencies: {
        postgres: "ready",
        redis: "ready",
        minio: "not_ready",
        mailpit: "ready",
        worker: "not_ready",
      },
    });
  });

  it("returns 200 once every dependency is ready", async () => {
    Object.assign(readinessChecks, {
      postgres: async () => true,
      redis: async () => true,
      minio: async () => true,
      mailpit: async () => true,
      worker: async () => true,
    });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(ReadinessResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toEqual({
      status: "ready",
      dependencies: {
        postgres: "ready",
        redis: "ready",
        minio: "ready",
        mailpit: "ready",
        worker: "ready",
      },
    });
  });

  it("documents the runtime problem as the only readiness error extension", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().components.schemas).toEqual(expect.objectContaining({
      ReadinessResponseDto_Output: expect.anything(),
      RuntimeNotReadyProblemDto: expect.anything(),
    }));
  });
});

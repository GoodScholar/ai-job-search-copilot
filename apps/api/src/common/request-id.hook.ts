import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

function isUuid(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function getRequestId(request: FastifyRequest): string {
  return request.requestId;
}

@Injectable()
export class RequestIdHook implements OnModuleInit {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
    fastify.addHook("onRequest", (request, reply, done) => {
      const header = request.headers["x-request-id"];
      const suppliedRequestId = typeof header === "string" ? header : undefined;
      request.requestId = isUuid(suppliedRequestId) ? suppliedRequestId : randomUUID();
      reply.header("x-request-id", request.requestId);
      done();
    });
  }
}

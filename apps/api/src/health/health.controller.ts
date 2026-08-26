import { Controller, Get, HttpStatus, Inject, Req } from "@nestjs/common";
import { ApiServiceUnavailableResponse } from "@nestjs/swagger";
import { ReadinessResponseSchema, RuntimeNotReadyProblemSchema } from "@job-copilot/contracts/runtime";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { checkReadiness, READINESS_CHECKS, type ReadinessDependencies } from "./readiness.js";

class ReadinessResponseDto extends createZodDto(ReadinessResponseSchema) {}
class RuntimeNotReadyProblemDto extends createZodDto(RuntimeNotReadyProblemSchema) {}

@Controller("health")
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly readinessChecks: ReadinessDependencies) {}

  @Get("live")
  live() {
    return { status: "ok" as const };
  }

  @Get("ready")
  @ZodResponse({ type: ReadinessResponseDto, status: HttpStatus.OK })
  @ApiServiceUnavailableResponse({ type: RuntimeNotReadyProblemDto })
  async ready(@Req() request: FastifyRequest) {
    const readiness = await checkReadiness(this.readinessChecks);
    if (readiness.status === "not_ready") {
      const problem = RuntimeNotReadyProblemSchema.parse({
        code: "RUNTIME_NOT_READY",
        message: "运行依赖未就绪",
        requestId: getRequestId(request),
        dependencies: readiness.dependencies,
      });
      throw new ApiException(
        problem.code,
        HttpStatus.SERVICE_UNAVAILABLE,
        problem.message,
        { dependencies: problem.dependencies },
      );
    }
    return ReadinessResponseSchema.parse(readiness);
  }
}

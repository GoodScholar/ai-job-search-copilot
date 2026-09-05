import { Controller, Get, HttpStatus, Inject, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBadRequestResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { RunPreflightReportSchema } from "@job-copilot/contracts/run-preflight";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { RUN_PREFLIGHT_QUERIES, type RunPreflightQueries } from "./run-preflight.tokens.js";

class RunPreflightReportDto extends createZodDto(RunPreflightReportSchema) {}
const RunPreflightQuerySchema = z.object({ workflow: z.enum(["discovery", "deep_match"]), trigger: z.enum(["manual", "schedule", "automatic"]), targetId: z.uuid().optional() }).strict();
class RunPreflightQueryDto extends createZodDto(RunPreflightQuerySchema) {}

@Controller("v1/run-preflight")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class RunPreflightController {
  constructor(@Inject(RUN_PREFLIGHT_QUERIES) private readonly queries: RunPreflightQueries) {}

  static preflightConflict(error: RunPreflightRejectedError): ApiException {
    return new ApiException(error.code, HttpStatus.CONFLICT, error.code === "RUN_PREFLIGHT_BLOCKED" ? "运行前检查未通过" : "请确认当前运行前检查提示", { preflight: error.report });
  }

  @Get()
  @ZodResponse({ type: RunPreflightReportDto })
  @ApiBadRequestResponse() @ApiUnauthorizedResponse()
  async get(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Query() query: RunPreflightQueryDto) {
    const parsed = RunPreflightQuerySchema.parse(query);
    reply.header("Cache-Control", "no-store");
    return RunPreflightReportSchema.parse(await this.queries.get({ userId: request.authenticatedAccount!.userId, workflow: parsed.workflow, trigger: parsed.trigger, targetId: parsed.targetId }));
  }
}

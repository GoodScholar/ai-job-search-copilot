import { Body, Controller, Get, HttpStatus, Inject, Post, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBadRequestResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { ModelDiagnosticPublicResponseSchema } from "@job-copilot/contracts/model-diagnostics";
import type { FastifyReply } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { MODEL_DIAGNOSTICS, type ModelDiagnostics } from "./model-diagnostics.tokens.js";

class ModelDiagnosticResponseDto extends createZodDto(ModelDiagnosticPublicResponseSchema) {}
function assertEmptyBody(body: unknown): void {
  if (body === undefined || (typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 0)) return;
  throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
}

@Controller("v1/model-diagnostics")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class ModelDiagnosticsController {
  constructor(@Inject(MODEL_DIAGNOSTICS) private readonly diagnostics: ModelDiagnostics) {}
  @Get() @ZodResponse({ type: ModelDiagnosticResponseDto }) @ApiUnauthorizedResponse({ description: "需要有效会话" })
  async get(@Res({ passthrough: true }) reply: FastifyReply) { reply.header("Cache-Control", "no-store"); return this.diagnostics.get(); }
  @Post() @ZodResponse({ type: ModelDiagnosticResponseDto }) @ApiBadRequestResponse({ description: "请求无效" })
  async run(@Res({ passthrough: true }) reply: FastifyReply, @Body() body?: unknown) { assertEmptyBody(body); reply.header("Cache-Control", "no-store"); return this.diagnostics.run(); }
}

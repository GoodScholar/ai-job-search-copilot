import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { ControlRecommendationRunCommandSchema, RecommendationRunPreparationSchema, RecommendationRunSchema, StartRecommendationRunCommandSchema } from "@job-copilot/contracts/recommendation-runs";
import { AccountRunAdmissionError } from "@job-copilot/domain/account-run-control";
import { RecommendationRunError } from "@job-copilot/domain/recommendation-runs";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiProblem } from "../auth/auth.controller.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { RECOMMENDATION_RUN_COMMANDS, RECOMMENDATION_RUN_QUERIES, type RecommendationRunCommands, type RecommendationRunQueries } from "../agent-runs/agent-runs.tokens.js";
import { runPreflightConflict } from "../run-preflight/run-preflight-error.js";
import { RECOMMENDATION_RUN_PREPARATION_QUERIES, type RecommendationRunPreparationQueries } from "./recommendation-runs.tokens.js";

class StartDto extends createZodDto(StartRecommendationRunCommandSchema) {}
class ControlDto extends createZodDto(ControlRecommendationRunCommandSchema) {}
class RunPathDto extends createZodDto(z.object({ runId: z.uuid() }).strict()) {}
class PreparationDto extends createZodDto(z.object({ preparation: RecommendationRunPreparationSchema }).strict()) {}
class RunDto extends createZodDto(RecommendationRunSchema) {}
class LatestRunDto extends createZodDto(z.object({ run: RecommendationRunSchema.nullable() }).strict()) {}
class StartResponseDto extends createZodDto(z.object({ run: RecommendationRunSchema, reused: z.boolean() }).strict()) {}
class ControlResponseDto extends createZodDto(z.object({ applied: z.boolean(), run: RecommendationRunSchema }).strict()) {}

function missing() { return new ApiException("RECOMMENDATION_RUN_NOT_FOUND", HttpStatus.NOT_FOUND, "推荐运行不存在"); }
function controlError(error: RecommendationRunError) {
  if (error.code === "RECOMMENDATION_RUN_NOT_FOUND") return missing();
  return new ApiException(error.code, HttpStatus.CONFLICT, "推荐运行状态已变化，请刷新后重试");
}

@Controller("v1/recommendation-runs")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class RecommendationRunsController {
  constructor(
    @Inject(RECOMMENDATION_RUN_COMMANDS) private readonly commands: RecommendationRunCommands,
    @Inject(RECOMMENDATION_RUN_QUERIES) private readonly queries: RecommendationRunQueries,
    @Inject(RECOMMENDATION_RUN_PREPARATION_QUERIES) private readonly preparationQueries: RecommendationRunPreparationQueries,
  ) {}

  @Get("preparation") @ZodResponse({ type: PreparationDto })
  async preparation(@Req() request: FastifyRequest) { return { preparation: await this.preparationQueries.prepare({ userId: request.authenticatedAccount!.userId }) }; }

  @Post() @ZodResponse({ type: StartResponseDto, status: HttpStatus.CREATED }) @ZodResponse({ type: StartResponseDto, status: HttpStatus.OK }) @ApiBadRequestResponse({ type: ApiProblem }) @ApiConflictResponse({ type: ApiProblem })
  async start(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() command: StartDto) {
    try { const result = await this.commands.start({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), command }); reply.status(result.reused ? HttpStatus.OK : HttpStatus.CREATED); return result; }
    catch (error) {
      if (error instanceof RunPreflightRejectedError) throw runPreflightConflict(error);
      if (error instanceof AccountRunAdmissionError && error.code === "ACCOUNT_RUN_STOPPED") throw new ApiException(error.code, HttpStatus.CONFLICT, "账户已停止全部运行，请先解除全局停止");
      if (error instanceof RecommendationRunError && error.code === "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT") throw controlError(error);
      throw error;
    }
  }

  @Get("latest") @ZodResponse({ type: LatestRunDto })
  async latest(@Req() request: FastifyRequest) { return { run: await this.queries.latest({ userId: request.authenticatedAccount!.userId }) }; }

  @Get("latest-result") @ZodResponse({ type: LatestRunDto })
  async latestResult(@Req() request: FastifyRequest) { return { run: await this.queries.latestPublished({ userId: request.authenticatedAccount!.userId }) }; }

  @Get(":runId") @ZodResponse({ type: RunDto }) @ApiNotFoundResponse({ type: ApiProblem })
  async get(@Req() request: FastifyRequest, @Param() params: RunPathDto) { const run = await this.queries.get({ userId: request.authenticatedAccount!.userId, runId: params.runId }); if (!run) throw missing(); return run; }

  @Post(":runId/controls") @HttpCode(HttpStatus.OK) @ZodResponse({ type: ControlResponseDto }) @ApiConflictResponse({ type: ApiProblem }) @ApiNotFoundResponse({ type: ApiProblem }) @ApiUnauthorizedResponse({ type: ApiProblem })
  async control(@Req() request: FastifyRequest, @Param() params: RunPathDto, @Body() command: ControlDto) {
    try { return await this.commands.control({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), runId: params.runId, command }); }
    catch (error) {
      if (error instanceof RecommendationRunError) throw controlError(error);
      if (error instanceof AccountRunAdmissionError && error.code === "ACCOUNT_RUN_STOPPED") throw new ApiException(error.code, HttpStatus.CONFLICT, "账户已停止全部运行，请先解除全局停止");
      throw error;
    }
  }
}

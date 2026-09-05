import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { CalibrationProposalCommandResponseSchema, CalibrationProposalRebaseCommandSchema, CalibrationProposalResolutionCommandSchema, CalibrationProposalRevisionCommandSchema, RecommendationDecisionCommandSchema, RecommendationExclusionPageSchema, RecommendationListHistoryPageSchema, RecommendationListSchema, StartRecommendationReevaluationCommandSchema } from "@job-copilot/contracts/recommendations";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { RECOMMENDATION_FEEDBACK_COMMANDS, RECOMMENDATION_FEEDBACK_QUERIES, RECOMMENDATION_QUERIES, type RecommendationFeedbackCommands, type RecommendationFeedbackQueries, type RecommendationQueries } from "./recommendations.tokens.js";
import { RECOMMENDATION_RUN_STARTER, type RecommendationRunStarter } from "./recommendations.tokens.js";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import { RunPreflightController } from "../run-preflight/run-preflight.controller.js";

class RecommendationListDto extends createZodDto(RecommendationListSchema) {}
class RecommendationTargetQueryDto extends createZodDto(z.object({ targetId: z.uuid() }).strict()) {}
class RecommendationCursorQueryDto extends createZodDto(z.object({ targetId: z.uuid(), cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict()) {}
class RecommendationListExclusionsQueryDto extends createZodDto(z.object({ targetId: z.uuid(), cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict()) {}
class RecommendationListIdParamDto extends createZodDto(z.object({ recommendationListId: z.uuid() }).strict()) {}
class StartRecommendationReevaluationDto extends createZodDto(StartRecommendationReevaluationCommandSchema) {}
class CalibrationProposalRevisionDto extends createZodDto(CalibrationProposalRevisionCommandSchema) {}
class CalibrationProposalRebaseDto extends createZodDto(CalibrationProposalRebaseCommandSchema) {}
class CalibrationProposalCommandResponseDto extends createZodDto(CalibrationProposalCommandResponseSchema) {}
class CalibrationProposalResolutionDto extends createZodDto(CalibrationProposalResolutionCommandSchema) {}
class CalibrationProposalIdParamDto extends createZodDto(z.object({ id: z.uuid() }).strict()) {}

@Controller("v1/recommendations")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class RecommendationsController {
  constructor(@Inject(RECOMMENDATION_QUERIES) private readonly queries: RecommendationQueries, @Inject(RECOMMENDATION_RUN_STARTER) private readonly starter: RecommendationRunStarter, @Inject(RECOMMENDATION_FEEDBACK_COMMANDS) private readonly feedback: RecommendationFeedbackCommands, @Inject(RECOMMENDATION_FEEDBACK_QUERIES) private readonly feedbackQueries: RecommendationFeedbackQueries) {}

  @Get("latest")
  @ZodResponse({ type: RecommendationListDto })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  async latest(@Req() request: FastifyRequest, @Query() query: RecommendationTargetQueryDto) {
    const list = await this.queries.getLatestList({ userId: request.authenticatedAccount!.userId, targetId: query.targetId });
    if (!list) throw new ApiException("RECOMMENDATION_LIST_NOT_FOUND", 404, "推荐清单不存在");
    return RecommendationListSchema.parse(list);
  }

  @Get("history")
  async history(@Req() request: FastifyRequest, @Query() query: RecommendationCursorQueryDto) {
    return RecommendationListHistoryPageSchema.parse(await this.queries.getListHistoryPage({ userId: request.authenticatedAccount!.userId, targetId: query.targetId, cursor: query.cursor, limit: query.limit }));
  }

  @Get("lists/:recommendationListId/exclusions")
  async exclusions(@Req() request: FastifyRequest, @Param() params: RecommendationListIdParamDto, @Query() query: RecommendationListExclusionsQueryDto) {
    return RecommendationExclusionPageSchema.parse(await this.queries.getListExclusionsPage({ userId: request.authenticatedAccount!.userId, targetId: query.targetId, recommendationListId: params.recommendationListId, cursor: query.cursor, limit: query.limit }));
  }

  @Post("runs")
  @ApiConflictResponse()
  async reevaluate(@Req() request: FastifyRequest, @Body() body: StartRecommendationReevaluationDto) {
    try { return await this.starter.start({ userId: request.authenticatedAccount!.userId, targetId: body.targetId, opportunityId: body.opportunityId, idempotencyKey: body.idempotencyKey, warningFingerprint: body.warningFingerprint, trigger: "manual" }); }
    catch (error) { if (error instanceof RunPreflightRejectedError) throw RunPreflightController.preflightConflict(error); throw error; }
  }

  @Post("lists/:listId/items/:itemId/decisions")
  async recordDecision(@Req() request: FastifyRequest, @Param() params: { listId: string; itemId: string }, @Body() body: unknown) {
    const parsed = z.object({ listId: z.uuid(), itemId: z.uuid() }).strict().safeParse(params);
    if (!parsed.success) throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
    try {
      return await this.feedback.recordDecision({ userId: request.authenticatedAccount!.userId, recommendationListId: parsed.data.listId, recommendationListItemId: parsed.data.itemId, command: RecommendationDecisionCommandSchema.parse(body) });
    } catch (error) { throw feedbackException(error); }
  }

  @Get("calibration-proposals")
  async calibrationProposals(@Req() request: FastifyRequest, @Query() query: RecommendationTargetQueryDto) {
    return this.feedbackQueries.listCalibrationProposals({ userId: request.authenticatedAccount!.userId, targetId: query.targetId });
  }

  @Post("calibration-proposals/:id/revisions")
  @ZodResponse({ type: CalibrationProposalCommandResponseDto })
  async reviseProposal(@Req() request: FastifyRequest, @Param() params: CalibrationProposalIdParamDto, @Body() body: CalibrationProposalRevisionDto) {
    try { return CalibrationProposalCommandResponseSchema.parse(await this.feedback.reviseCalibrationProposal({ userId: request.authenticatedAccount!.userId, proposalId: params.id, command: body })); }
    catch (error) { throw feedbackException(error); }
  }

  @Post("calibration-proposals/:id/rebases")
  @ZodResponse({ type: CalibrationProposalCommandResponseDto })
  async rebaseProposal(@Req() request: FastifyRequest, @Param() params: CalibrationProposalIdParamDto, @Body() body: CalibrationProposalRebaseDto) {
    try { return CalibrationProposalCommandResponseSchema.parse(await this.feedback.rebaseCalibrationProposal({ userId: request.authenticatedAccount!.userId, proposalId: params.id, command: body })); }
    catch (error) { throw feedbackException(error); }
  }

  @Post("calibration-proposals/:id/resolutions")
  async resolveProposal(@Req() request: FastifyRequest, @Param() params: CalibrationProposalIdParamDto, @Body() body: CalibrationProposalResolutionDto) {
    try { return await this.feedback.resolveCalibrationProposal({ userId: request.authenticatedAccount!.userId, proposalId: params.id, command: body }); }
    catch (error) { throw feedbackException(error); }
  }

}

function feedbackException(error: unknown): ApiException {
  if (error instanceof z.ZodError) return new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "INTERNAL_ERROR";
  if (code === "VERSION_CONFLICT" || code === "RULE_VERSION_CONFLICT" || code === "IDEMPOTENCY_CONFLICT") return new ApiException(code, HttpStatus.CONFLICT, "请求与当前状态冲突");
  if (code === "PROPOSAL_NO_EFFECT") return new ApiException(code, HttpStatus.UNPROCESSABLE_ENTITY, "建议不会改变当前规则");
  if (code === "RECOMMENDATION_ITEM_NOT_FOUND" || code === "PROPOSAL_NOT_FOUND") return new ApiException(code, HttpStatus.NOT_FOUND, "资源不存在");
  return new ApiException(code, HttpStatus.INTERNAL_SERVER_ERROR, "推荐反馈暂时不可用");
}

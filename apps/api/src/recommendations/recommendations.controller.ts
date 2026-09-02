import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { RecommendationExclusionPageSchema, RecommendationListHistoryPageSchema, RecommendationListSchema } from "@job-copilot/contracts/recommendations";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { RECOMMENDATION_QUERIES, type RecommendationQueries } from "./recommendations.tokens.js";
import { RECOMMENDATION_RUN_STARTER, type RecommendationRunStarter } from "./recommendations.tokens.js";

class RecommendationListDto extends createZodDto(RecommendationListSchema) {}
class RecommendationTargetQueryDto extends createZodDto(z.object({ targetId: z.uuid() }).strict()) {}
class RecommendationCursorQueryDto extends createZodDto(z.object({ targetId: z.uuid(), cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict()) {}
class RecommendationListExclusionsQueryDto extends createZodDto(z.object({ targetId: z.uuid(), cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict()) {}
class RecommendationListIdParamDto extends createZodDto(z.object({ recommendationListId: z.uuid() }).strict()) {}
class StartRecommendationReevaluationDto extends createZodDto(z.object({ targetId: z.uuid(), opportunityId: z.uuid(), idempotencyKey: z.uuid() }).strict()) {}

@Controller("v1/recommendations")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class RecommendationsController {
  constructor(@Inject(RECOMMENDATION_QUERIES) private readonly queries: RecommendationQueries, @Inject(RECOMMENDATION_RUN_STARTER) private readonly starter: RecommendationRunStarter) {}

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
  async reevaluate(@Req() request: FastifyRequest, @Body() body: StartRecommendationReevaluationDto) {
    return this.starter.start({ userId: request.authenticatedAccount!.userId, targetId: body.targetId, opportunityId: body.opportunityId, idempotencyKey: body.idempotencyKey, trigger: "manual" });
  }

}

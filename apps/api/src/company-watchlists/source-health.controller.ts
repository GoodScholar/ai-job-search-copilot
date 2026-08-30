import { Controller, Get, HttpStatus, Inject, Param, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { JobSourceHealthOverviewSchema } from "@job-copilot/contracts/agent-runs";
import { CompanyWatchlistError } from "@job-copilot/domain/company-watchlists";
import type { SourceHealthQueries } from "@job-copilot/domain/source-health";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { SOURCE_HEALTH_QUERIES } from "./company-watchlists.tokens.js";

class SourceHealthOverviewDto extends createZodDto(JobSourceHealthOverviewSchema) {}
class TargetPathDto extends createZodDto(z.object({ targetId: z.uuid() }).strict()) {}

@Controller("v1/job-targets/:targetId/source-health")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class SourceHealthController {
  constructor(@Inject(SOURCE_HEALTH_QUERIES) private readonly queries: SourceHealthQueries) {}
  @Get()
  @ZodResponse({ type: SourceHealthOverviewDto, status: HttpStatus.OK })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async get(@Req() request: FastifyRequest, @Param() params: TargetPathDto) {
    try { return await this.queries.get({ userId: request.authenticatedAccount!.userId, targetId: params.targetId }); }
    catch (error) {
      if (error instanceof CompanyWatchlistError && error.code === "COMPANY_WATCHLIST_TARGET_NOT_FOUND") throw new ApiException(error.code, HttpStatus.NOT_FOUND, "求职目标不存在");
      throw error;
    }
  }
}

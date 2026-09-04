import { Controller, Get, HttpStatus, Inject, Param, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { SourceCapabilityProjectionOverviewSchema } from "@job-copilot/contracts/source-capabilities";
import { CompanyWatchlistError } from "@job-copilot/domain/company-watchlists";
import type { SourceCapabilityProjectionQueries } from "@job-copilot/domain/source-capability-projections";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { SOURCE_CAPABILITY_PROJECTION_QUERIES } from "./company-watchlists.tokens.js";

class SourceCapabilityProjectionOverviewDto extends createZodDto(SourceCapabilityProjectionOverviewSchema) {}
class TargetPathDto extends createZodDto(z.object({ targetId: z.uuid() }).strict()) {}

@Controller("v1/job-targets/:targetId/source-capabilities")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class SourceCapabilitiesController {
  constructor(@Inject(SOURCE_CAPABILITY_PROJECTION_QUERIES) private readonly queries: SourceCapabilityProjectionQueries) {}
  @Get()
  @ZodResponse({ type: SourceCapabilityProjectionOverviewDto, status: HttpStatus.OK })
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

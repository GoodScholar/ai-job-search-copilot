import { Body, Controller, Get, HttpStatus, Inject, Put, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { FirstRecommendationJourneyInteractionCommandSchema, FirstRecommendationJourneyInteractionSchema, WorkbenchHomeSchema } from "@job-copilot/contracts/workbench";
import { FirstRecommendationJourneyError } from "@job-copilot/domain/first-recommendation-journey";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { ApiException } from "../common/api-problem.filter.js";
import { FIRST_RECOMMENDATION_JOURNEY_COMMANDS, WORKBENCH_HOME, type FirstRecommendationJourneyCommands, type WorkbenchHomeService } from "./workbench.tokens.js";

class WorkbenchHomeDto extends createZodDto(WorkbenchHomeSchema) {}
const FirstRecommendationJourneyInteractionCommandDto = createZodDto(FirstRecommendationJourneyInteractionCommandSchema);
Object.defineProperty(FirstRecommendationJourneyInteractionCommandDto, "name", { value: "FirstRecommendationJourneyInteractionCommandDto" });
class FirstRecommendationJourneyInteractionDto extends createZodDto(FirstRecommendationJourneyInteractionSchema) {}

function journeyProblem(error: unknown): never {
  if (!(error instanceof FirstRecommendationJourneyError)) throw error;
  switch (error.code) {
    case "ACCOUNT_NOT_FOUND": throw new ApiException(error.code, HttpStatus.NOT_FOUND, "求职账户不存在");
    case "VERSION_CONFLICT": throw new ApiException(error.code, HttpStatus.CONFLICT, "首次推荐旅程已在其他位置更新，请刷新后重试");
    case "JOURNEY_COMPLETED": throw new ApiException(error.code, HttpStatus.CONFLICT, "首次推荐旅程已经完成");
  }
}

@Controller("v1/workbench")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class WorkbenchController {
  constructor(
    @Inject(WORKBENCH_HOME) private readonly getWorkbenchHome: WorkbenchHomeService,
    @Inject(FIRST_RECOMMENDATION_JOURNEY_COMMANDS) private readonly firstRecommendationJourneyCommands: FirstRecommendationJourneyCommands,
  ) {}

  @Get("home")
  @ZodResponse({ type: WorkbenchHomeDto })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  getHome(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    return this.getWorkbenchHome({ userId: request.authenticatedAccount!.userId });
  }

  @Put("first-recommendation-journey")
  @ApiBody({ type: FirstRecommendationJourneyInteractionCommandDto })
  @ZodResponse({ type: FirstRecommendationJourneyInteractionDto, status: HttpStatus.OK })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async updateJourney(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    reply.header("Cache-Control", "no-store");
    const command = FirstRecommendationJourneyInteractionCommandSchema.safeParse(body);
    if (!command.success) throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
    try {
      return FirstRecommendationJourneyInteractionSchema.parse(await this.firstRecommendationJourneyCommands.updateInteraction({
        userId: request.authenticatedAccount!.userId,
        command: command.data,
      }));
    } catch (error) {
      return journeyProblem(error);
    }
  }
}

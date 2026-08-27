import { Body, Controller, HttpStatus, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { ResolveCareerFactConflictCommandSchema, ResolveCareerFactConflictResponseSchema } from "@job-copilot/contracts/career-import";
import { CareerFactConflictReviewError, type createCareerFactConflictReviewCommands } from "@job-copilot/domain/career-fact-conflict-review";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { CAREER_FACT_CONFLICT_REVIEW_COMMANDS } from "./profile-review.tokens.js";

class ResolveCareerFactConflictResponseDto extends createZodDto(ResolveCareerFactConflictResponseSchema) {}
class CareerFactConflictPathDto extends createZodDto(z.object({ conflictId: z.uuid() }).strict()) {}

@Controller("v1/career-documents/fact-conflicts")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class CareerFactConflictReviewController {
  constructor(@Inject(CAREER_FACT_CONFLICT_REVIEW_COMMANDS) private readonly commands: ReturnType<typeof createCareerFactConflictReviewCommands>) {}

  @Post(":conflictId/resolutions")
  @ZodResponse({ type: ResolveCareerFactConflictResponseDto })
  @ApiBadRequestResponse({ type: ApiProblem }) @ApiConflictResponse({ type: ApiProblem }) @ApiNotFoundResponse({ type: ApiProblem }) @ApiUnauthorizedResponse({ type: ApiProblem })
  async resolve(@Req() request: FastifyRequest, @Param() params: CareerFactConflictPathDto, @Body() body: unknown) {
    const command = ResolveCareerFactConflictCommandSchema.safeParse(body);
    if (!command.success) throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
    try {
      return await this.commands.resolve({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), conflictId: params.conflictId, command: command.data });
    } catch (error) {
      if (!(error instanceof CareerFactConflictReviewError)) throw error;
      if (error.code === "CAREER_FACT_CONFLICT_NOT_FOUND") throw new ApiException(error.code, HttpStatus.NOT_FOUND, "职业事实冲突不存在");
      if (error.code === "PROFILE_VERSION_CONFLICT" || error.code === "CAREER_FACT_CONFLICT_ALREADY_RESOLVED") throw new ApiException(error.code, HttpStatus.CONFLICT, "画像已在其他位置更新，请刷新后重试");
      throw new ApiException(error.code, HttpStatus.BAD_REQUEST, "职业事实冲突无法解决");
    }
  }
}

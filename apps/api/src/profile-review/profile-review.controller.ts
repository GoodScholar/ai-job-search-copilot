import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import {
  CandidateFactDecisionCommandSchema,
  CreateProfileFactCommandSchema,
  ProfileSnapshotSchema,
  RemoveProfileFactCommandSchema,
  ReviseProfileFactCommandSchema,
} from "@job-copilot/contracts/profile-review";
import { ProfileReviewError } from "@job-copilot/domain/profile-review";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { PROFILE_REVIEW_COMMANDS, TRUSTED_PROFILE_QUERIES, type ProfileReviewCommands, type TrustedProfileQueries } from "./profile-review.tokens.js";

class ProfileSnapshotDto extends createZodDto(ProfileSnapshotSchema) {}
class ReviseProfileFactCommandDto extends createZodDto(ReviseProfileFactCommandSchema) {}
class RemoveProfileFactCommandDto extends createZodDto(RemoveProfileFactCommandSchema) {}
class CandidateFactPathDto extends createZodDto(z.object({ factId: z.uuid() }).strict()) {}
class ProfileFactPathDto extends createZodDto(z.object({ factId: z.uuid() }).strict()) {}

function profileProblem(error: unknown): never {
  if (!(error instanceof ProfileReviewError)) throw error;
  if (error.code === "PROFILE_VERSION_CONFLICT" || error.code === "CANDIDATE_FACT_ALREADY_DECIDED" || error.code === "CANDIDATE_FACT_CONFLICT_PENDING") {
    throw new ApiException(error.code, HttpStatus.CONFLICT, "画像已在其他位置更新，请刷新后重试");
  }
  if (error.code === "CANDIDATE_FACT_NOT_FOUND" || error.code === "PROFILE_FACT_NOT_FOUND") {
    throw new ApiException(error.code, HttpStatus.NOT_FOUND, "画像事实不存在");
  }
  throw new ApiException(error.code, HttpStatus.BAD_REQUEST, "画像事实无效");
}

@Controller("v1/profile")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class ProfileReviewController {
  constructor(
    @Inject(PROFILE_REVIEW_COMMANDS) private readonly commands: ProfileReviewCommands,
    @Inject(TRUSTED_PROFILE_QUERIES) private readonly queries: TrustedProfileQueries,
  ) {}

  @Get()
  @ZodResponse({ type: ProfileSnapshotDto })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  getCurrent(@Req() request: FastifyRequest) {
    return this.queries.getCurrent({ userId: request.authenticatedAccount!.userId });
  }

  @Post("candidate-facts/:factId/decisions")
  @ZodResponse({ type: ProfileSnapshotDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async decideCandidateFact(
    @Req() request: FastifyRequest,
    @Param() params: CandidateFactPathDto,
    @Body() body: unknown,
  ) {
    const parsedCommand = CandidateFactDecisionCommandSchema.safeParse(body);
    if (!parsedCommand.success) throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
    try {
      return await this.commands.decideCandidateFact({
        userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), candidateFactId: params.factId, command: parsedCommand.data,
      });
    } catch (error) {
      profileProblem(error);
    }
  }

  @Post("facts")
  @ZodResponse({ type: ProfileSnapshotDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  async createFact(@Req() request: FastifyRequest, @Body() body: unknown) {
    const parsedCommand = CreateProfileFactCommandSchema.safeParse(body);
    if (!parsedCommand.success) throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
    try {
      return await this.commands.createFact({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), command: parsedCommand.data });
    } catch (error) {
      profileProblem(error);
    }
  }

  @Post("facts/:factId/revisions")
  @ZodResponse({ type: ProfileSnapshotDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async reviseFact(@Req() request: FastifyRequest, @Param() params: ProfileFactPathDto, @Body() command: ReviseProfileFactCommandDto) {
    try {
      return await this.commands.reviseFact({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), profileFactId: params.factId, command });
    } catch (error) {
      profileProblem(error);
    }
  }

  @Post("facts/:factId/removals")
  @ZodResponse({ type: ProfileSnapshotDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async removeFact(@Req() request: FastifyRequest, @Param() params: ProfileFactPathDto, @Body() command: RemoveProfileFactCommandDto) {
    try {
      return await this.commands.removeFact({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), profileFactId: params.factId, command });
    } catch (error) {
      profileProblem(error);
    }
  }
}

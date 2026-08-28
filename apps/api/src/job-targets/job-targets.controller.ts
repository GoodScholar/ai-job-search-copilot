import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import {
  CreateJobTargetCommandSchema,
  DeactivateJobTargetCommandSchema,
  JobTargetOverviewSchema,
  ReviseJobTargetCommandSchema,
} from "@job-copilot/contracts/job-targets";
import { JobTargetError } from "@job-copilot/domain/job-targets";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { JOB_TARGET_COMMANDS, JOB_TARGET_QUERIES, type JobTargetCommands, type JobTargetQueries } from "./job-targets.tokens.js";

class JobTargetOverviewDto extends createZodDto(JobTargetOverviewSchema) {}
class JobTargetPathDto extends createZodDto(z.object({ targetId: z.uuid() }).strict()) {}
class CreateJobTargetCommandDto extends createZodDto(CreateJobTargetCommandSchema) {}
class ReviseJobTargetCommandDto extends createZodDto(ReviseJobTargetCommandSchema) {}
class DeactivateJobTargetCommandDto extends createZodDto(DeactivateJobTargetCommandSchema) {}

function jobTargetProblem(error: unknown): never {
  if (!(error instanceof JobTargetError)) throw error;
  if (error.code === "JOB_TARGET_NOT_FOUND") {
    throw new ApiException(error.code, HttpStatus.NOT_FOUND, "求职目标不存在");
  }
  if (error.code === "JOB_TARGET_VERSION_CONFLICT") {
    throw new ApiException(error.code, HttpStatus.CONFLICT, "求职目标已在其他位置更新，请刷新后重试");
  }
  throw new ApiException(error.code, HttpStatus.CONFLICT, "求职目标数量已达上限");
}

@Controller("v1/job-targets")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class JobTargetsController {
  constructor(
    @Inject(JOB_TARGET_COMMANDS) private readonly commands: JobTargetCommands,
    @Inject(JOB_TARGET_QUERIES) private readonly queries: JobTargetQueries,
  ) {}

  @Get()
  @ZodResponse({ type: JobTargetOverviewDto, status: HttpStatus.OK })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  getOverview(@Req() request: FastifyRequest) {
    return this.queries.getOverview({ userId: request.authenticatedAccount!.userId });
  }

  @Post()
  @ZodResponse({ type: JobTargetOverviewDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  async create(@Req() request: FastifyRequest, @Body() command: CreateJobTargetCommandDto) {
    try {
      return await this.commands.create({
        userId: request.authenticatedAccount!.userId,
        requestId: getRequestId(request),
        command,
      });
    } catch (error) {
      jobTargetProblem(error);
    }
  }

  @Post(":targetId/revisions")
  @ZodResponse({ type: JobTargetOverviewDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async revise(
    @Req() request: FastifyRequest,
    @Param() params: JobTargetPathDto,
    @Body() command: ReviseJobTargetCommandDto,
  ) {
    try {
      return await this.commands.revise({
        userId: request.authenticatedAccount!.userId,
        requestId: getRequestId(request),
        targetId: params.targetId,
        command,
      });
    } catch (error) {
      jobTargetProblem(error);
    }
  }

  @Post(":targetId/deactivations")
  @ZodResponse({ type: JobTargetOverviewDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async deactivate(
    @Req() request: FastifyRequest,
    @Param() params: JobTargetPathDto,
    @Body() command: DeactivateJobTargetCommandDto,
  ) {
    try {
      return await this.commands.deactivate({
        userId: request.authenticatedAccount!.userId,
        requestId: getRequestId(request),
        targetId: params.targetId,
        command,
      });
    } catch (error) {
      jobTargetProblem(error);
    }
  }
}

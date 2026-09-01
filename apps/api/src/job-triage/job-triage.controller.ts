import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { CreateJobTriageVersionCommandSchema, JobTriageVersionSchema } from "@job-copilot/contracts/job-triage";
import { JobTriageError } from "@job-copilot/domain/job-triage-persistence";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { JOB_TRIAGE_COMMANDS, JOB_TRIAGE_QUERIES, type JobTriageCommands, type JobTriageQueries } from "./job-triage.tokens.js";

class JobTriageVersionDto extends createZodDto(JobTriageVersionSchema) {}
class CreateJobTriageVersionCommandDto extends createZodDto(CreateJobTriageVersionCommandSchema) {}
class OpportunityPathDto extends createZodDto(z.object({ opportunityId: z.uuid() }).strict()) {}
class VersionPathDto extends createZodDto(z.object({ opportunityId: z.uuid(), triageVersionId: z.uuid() }).strict()) {}

function triageProblem(error: unknown): never {
  if (!(error instanceof JobTriageError)) throw error;
  if (error.code === "JOB_TRIAGE_OPPORTUNITY_NOT_FOUND" || error.code === "JOB_TRIAGE_TARGET_NOT_FOUND") {
    throw new ApiException(error.code, HttpStatus.NOT_FOUND, "岗位机会或求职目标不存在");
  }
  if (error.code === "JOB_TRIAGE_TARGET_INACTIVE") throw new ApiException(error.code, HttpStatus.CONFLICT, "求职目标已停用，不能评估岗位。");
  throw new ApiException(error.code, HttpStatus.CONFLICT, "请先补充已确认的求职画像事实。");
}

@Controller("v1/job-opportunities/:opportunityId/triage-versions")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class JobTriageController {
  constructor(@Inject(JOB_TRIAGE_COMMANDS) private readonly commands: JobTriageCommands, @Inject(JOB_TRIAGE_QUERIES) private readonly queries: JobTriageQueries) {}

  @Post()
  @ZodResponse({ type: JobTriageVersionDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async create(@Req() request: FastifyRequest, @Param() params: OpportunityPathDto, @Body() command: CreateJobTriageVersionCommandDto) {
    try {
      const { reused: _reused, ...result } = await this.commands.create({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), opportunityId: params.opportunityId, command });
      return result;
    } catch (error) {
      triageProblem(error);
    }
  }

  @Get("latest")
  @ZodResponse({ type: JobTriageVersionDto, status: HttpStatus.OK })
  @ApiNotFoundResponse({ type: ApiProblem })
  getLatest(@Req() request: FastifyRequest, @Param() params: OpportunityPathDto) {
    return this.requireVersion(this.queries.getLatest({ userId: request.authenticatedAccount!.userId, opportunityId: params.opportunityId }));
  }

  @Get(":triageVersionId")
  @ZodResponse({ type: JobTriageVersionDto, status: HttpStatus.OK })
  @ApiNotFoundResponse({ type: ApiProblem })
  get(@Req() request: FastifyRequest, @Param() params: VersionPathDto) {
    return this.requireVersion(this.queries.get({ userId: request.authenticatedAccount!.userId, opportunityId: params.opportunityId, triageVersionId: params.triageVersionId }));
  }

  private async requireVersion<T>(promise: Promise<T | null>): Promise<T> {
    const version = await promise;
    if (!version) throw new ApiException("JOB_TRIAGE_VERSION_NOT_FOUND", HttpStatus.NOT_FOUND, "岗位评估不存在");
    return version;
  }
}

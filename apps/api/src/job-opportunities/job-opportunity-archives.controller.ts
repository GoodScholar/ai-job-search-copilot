import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { JobOpportunityArchiveCommandResponseSchema, JobOpportunityArchiveCommandSchema, JobOpportunityArchiveFilterSchema, JobOpportunityArchivePageSchema } from "@job-copilot/contracts/job-opportunity-archives";
import { JobOpportunityArchiveError } from "@job-copilot/domain/job-opportunity-archives";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { JOB_OPPORTUNITY_ARCHIVE_COMMANDS, JOB_OPPORTUNITY_ARCHIVE_QUERIES, type JobOpportunityArchiveCommands, type JobOpportunityArchiveQueries } from "./job-opportunity-archives.tokens.js";

class OpportunityIdDto extends createZodDto(z.object({ opportunityId: z.uuid() }).strict()) {}
class ArchiveCommandDto extends createZodDto(JobOpportunityArchiveCommandSchema) {}
class ArchiveQueryDto extends createZodDto(z.object({ filter: JobOpportunityArchiveFilterSchema.default("active"), cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict()) {}
class ArchivePageDto extends createZodDto(JobOpportunityArchivePageSchema) {}
class ArchiveCommandResponseDto extends createZodDto(JobOpportunityArchiveCommandResponseSchema) {}

@Controller("v1/job-opportunities")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class JobOpportunityArchivesController {
  constructor(
    @Inject(JOB_OPPORTUNITY_ARCHIVE_COMMANDS) private readonly commands: JobOpportunityArchiveCommands,
    @Inject(JOB_OPPORTUNITY_ARCHIVE_QUERIES) private readonly queries: JobOpportunityArchiveQueries,
  ) {}

  @Get()
  @ZodResponse({ type: ArchivePageDto })
  @ApiUnauthorizedResponse()
  async list(@Req() request: FastifyRequest, @Query() query: ArchiveQueryDto) {
    try { return await this.queries.list({ userId: request.authenticatedAccount!.userId, filter: query.filter, cursor: query.cursor, limit: query.limit }); }
    catch (error) { throw archiveException(error); }
  }

  @Post(":opportunityId/archive-state")
  @ZodResponse({ type: ArchiveCommandResponseDto })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  async change(@Req() request: FastifyRequest, @Param() params: OpportunityIdDto, @Body() command: ArchiveCommandDto) {
    try {
      return await this.commands.change({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), opportunityId: params.opportunityId, command });
    } catch (error) { throw archiveException(error); }
  }
}

function archiveException(error: unknown): ApiException {
  if (!(error instanceof JobOpportunityArchiveError)) return new ApiException("INTERNAL_ERROR", HttpStatus.INTERNAL_SERVER_ERROR, "岗位归档暂时不可用");
  if (error.code === "JOB_OPPORTUNITY_NOT_FOUND" || error.code === "JOB_OPPORTUNITY_ARCHIVE_CURSOR_INVALID") return new ApiException("JOB_OPPORTUNITY_NOT_FOUND", HttpStatus.NOT_FOUND, "岗位机会不存在");
  return new ApiException(error.code, HttpStatus.CONFLICT, "请求与当前岗位状态冲突");
}

import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiServiceUnavailableResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { createZodDto, ZodResponse } from "nestjs-zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { JobExportCommandSchema, JobExportListSchema, JobExportSchema } from "@job-copilot/contracts/job-exports";
import { JobExportError } from "@job-copilot/domain/job-exports";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { JOB_EXPORT_COMMANDS, JOB_EXPORT_QUERIES, JOB_EXPORT_STORE, type JobExportCommands, type JobExportQueries, type JobExportStore } from "./job-exports.tokens.js";

class JobExportCommandDto extends createZodDto(JobExportCommandSchema) {}
class JobExportDto extends createZodDto(JobExportSchema) {}
class JobExportListDto extends createZodDto(JobExportListSchema) {}
class ExportIdDto extends createZodDto(JobExportSchema.pick({ id: true })) {}

@Controller("v1/job-exports")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class JobExportsController {
  constructor(
    @Inject(JOB_EXPORT_COMMANDS) private readonly commands: JobExportCommands,
    @Inject(JOB_EXPORT_QUERIES) private readonly queries: JobExportQueries,
    @Inject(JOB_EXPORT_STORE) private readonly store: JobExportStore,
  ) {}

  @Post()
  @ZodResponse({ type: JobExportDto })
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  async create(@Req() request: FastifyRequest, @Body() command: JobExportCommandDto) {
    try { return await this.commands.create({ userId: request.authenticatedAccount!.userId, command }); }
    catch (error) { throw exportException(error); }
  }

  @Get()
  @ZodResponse({ type: JobExportListDto })
  @ApiUnauthorizedResponse()
  async list(@Req() request: FastifyRequest) { return this.queries.list({ userId: request.authenticatedAccount!.userId }); }

  @Get(":id")
  @ZodResponse({ type: JobExportDto })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  async get(@Req() request: FastifyRequest, @Param() params: ExportIdDto) {
    const value = await this.queries.get({ userId: request.authenticatedAccount!.userId, exportId: params.id });
    if (!value) throw exportException(new JobExportError("JOB_EXPORT_NOT_FOUND"));
    return value;
  }

  @Get(":id/download")
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  @ApiServiceUnavailableResponse()
  async download(@Req() request: FastifyRequest, @Param() params: ExportIdDto, @Res() reply: FastifyReply) {
    try {
      const input = { userId: request.authenticatedAccount!.userId, exportId: params.id };
      const descriptor = await this.queries.download(input);
      const bytes = await this.store.get(descriptor);
      await this.queries.download(input);
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename=job-opportunities-${params.id}.csv`);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(Buffer.from(bytes));
    } catch (error) { throw exportException(error); }
  }
}

function exportException(error: unknown): ApiException {
  if (!(error instanceof JobExportError)) return new ApiException("JOB_EXPORT_STORAGE_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE, "岗位导出暂时不可用");
  if (error.code === "JOB_EXPORT_NOT_FOUND") return new ApiException("JOB_EXPORT_NOT_FOUND", HttpStatus.NOT_FOUND, "岗位导出不存在");
  if (error.code === "JOB_EXPORT_EXPIRED") return new ApiException("JOB_EXPORT_EXPIRED", HttpStatus.GONE, "岗位导出已过期");
  if (error.code === "JOB_EXPORT_COMMAND_ID_CONFLICT" || error.code === "JOB_EXPORT_NOT_READY") return new ApiException(error.code, HttpStatus.CONFLICT, "岗位导出尚未可下载");
  return new ApiException("JOB_EXPORT_STORAGE_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE, "岗位导出暂时不可用");
}

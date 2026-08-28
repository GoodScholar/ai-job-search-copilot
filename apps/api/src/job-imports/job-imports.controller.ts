import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiNotFoundResponse, ApiServiceUnavailableResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { CreateJobImportCommandSchema, CreateJobImportResponseSchema, JobImportDetailSchema, JobImportListSchema } from "@job-copilot/contracts/job-imports";
import { JobImportError } from "@job-copilot/domain/job-imports";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { JOB_IMPORT_COMMANDS, JOB_IMPORT_QUERIES, type JobImportCommands, type JobImportQueries } from "./job-imports.tokens.js";

class CreateJobImportResponseDto extends createZodDto(CreateJobImportResponseSchema) {}
class JobImportListDto extends createZodDto(JobImportListSchema) {}
class JobImportDetailDto extends createZodDto(JobImportDetailSchema) {}
class JobImportPathDto extends createZodDto(z.object({ importId: z.uuid() }).strict()) {}

function unavailable(error: JobImportError): ApiException {
  const messages: Record<JobImportError["code"], string> = {
    JOB_IMPORT_QUEUE_UNAVAILABLE: "岗位导入任务暂时不可用，请稍后重试",
    JOB_IMPORT_OBJECT_STORAGE_FAILED: "岗位正文暂时无法保存，请稍后重试",
  };
  return new ApiException(error.code, HttpStatus.SERVICE_UNAVAILABLE, messages[error.code]);
}

@Controller("v1/job-imports")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class JobImportsController {
  constructor(
    @Inject(JOB_IMPORT_COMMANDS) private readonly commands: JobImportCommands,
    @Inject(JOB_IMPORT_QUERIES) private readonly queries: JobImportQueries,
  ) {}

  @Post()
  @ApiBody({ schema: {
    oneOf: [
      { type: "object", required: ["inputType", "content"], additionalProperties: false, properties: { inputType: { type: "string", enum: ["pasted_text"] }, content: { type: "string", minLength: 1, maxLength: 524288 } } },
      { type: "object", required: ["inputType", "originalFilename", "content"], additionalProperties: false, properties: { inputType: { type: "string", enum: ["markdown_upload"] }, originalFilename: { type: "string", pattern: "\\.md$" }, content: { type: "string", minLength: 1, maxLength: 524288 } } },
    ],
  } })
  @ZodResponse({ type: CreateJobImportResponseDto, status: HttpStatus.ACCEPTED })
  @ZodResponse({ type: CreateJobImportResponseDto, status: HttpStatus.OK })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiServiceUnavailableResponse({ type: ApiProblem })
  async create(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() command: unknown,
  ) {
    try {
      const result = await this.commands.submit({
        userId: request.authenticatedAccount!.userId,
        requestId: getRequestId(request),
        command: CreateJobImportCommandSchema.parse(command),
      });
      reply.status(result.reused ? HttpStatus.OK : HttpStatus.ACCEPTED);
      const { reused: _reused, ...response } = result;
      return response;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
      }
      if (error instanceof JobImportError) throw unavailable(error);
      if (error instanceof Error && error.message === "JOB_IMPORT_CONTENT_INVALID") {
        throw new ApiException("JOB_IMPORT_CONTENT_INVALID", HttpStatus.BAD_REQUEST, "岗位正文不能为空且不能超过 512 KiB");
      }
      throw error;
    }
  }

  @Get()
  @ZodResponse({ type: JobImportListDto })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  list(@Req() request: FastifyRequest) {
    return this.queries.list({ userId: request.authenticatedAccount!.userId });
  }

  @Get(":importId/raw")
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiServiceUnavailableResponse({ type: ApiProblem })
  async raw(
    @Req() request: FastifyRequest,
    @Param() params: JobImportPathDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      const raw = await this.queries.getRawContent({ userId: request.authenticatedAccount!.userId, importId: params.importId });
      if (!raw) throw new ApiException("JOB_IMPORT_NOT_FOUND", HttpStatus.NOT_FOUND, "岗位导入不存在");
      await reply.type("text/plain; charset=utf-8").send(raw.content);
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException("JOB_IMPORT_OBJECT_STORAGE_FAILED", HttpStatus.SERVICE_UNAVAILABLE, "岗位正文暂时无法读取，请稍后重试");
    }
  }

  @Get(":importId")
  @ZodResponse({ type: JobImportDetailDto })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async get(@Req() request: FastifyRequest, @Param() params: JobImportPathDto) {
    const detail = await this.queries.get({ userId: request.authenticatedAccount!.userId, importId: params.importId });
    if (!detail) throw new ApiException("JOB_IMPORT_NOT_FOUND", HttpStatus.NOT_FOUND, "岗位导入不存在");
    return detail;
  }
}

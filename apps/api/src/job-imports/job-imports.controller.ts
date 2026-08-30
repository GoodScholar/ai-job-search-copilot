import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiNotFoundResponse, ApiServiceUnavailableResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { CreateJobImportCommandSchema, CreateJobImportResponseSchema, JobImportDetailSchema, JobImportListSchema } from "@job-copilot/contracts/job-imports";
import { JobImportError } from "@job-copilot/domain/job-imports";
import { JobPageFetchError } from "./job-page-fetcher.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { JOB_IMPORT_COMMANDS, JOB_IMPORT_QUERIES, JOB_PAGE_FETCHER, type JobImportCommands, type JobImportQueries, type JobPageFetcher } from "./job-imports.tokens.js";

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

function pageErrorMessage(code: JobPageFetchError["code"]): string {
  const messages: Record<JobPageFetchError["code"], string> = {
    JOB_PAGE_URL_INVALID: "岗位链接格式无效。", JOB_PAGE_TARGET_REJECTED: "该岗位链接不允许访问。",
    JOB_PAGE_REDIRECT_INVALID: "岗位链接跳转异常。", JOB_PAGE_TIMEOUT: "岗位页面读取超时，请稍后重试。", JOB_PAGE_CANCELLED: "岗位页面验证已取消，未导入。",
    JOB_PAGE_UNREACHABLE: "岗位页面暂时无法访问。", JOB_PAGE_RESPONSE_TOO_LARGE: "岗位页面内容过大。",
    JOB_PAGE_CONTENT_TYPE_INVALID: "该链接不是可导入的岗位页面。", JOB_PAGE_LISTING: "该链接是岗位列表，请提交具体岗位页面。",
    JOB_PAGE_LOGIN_REQUIRED: "该岗位页面需要登录后访问。", JOB_PAGE_EXPIRED: "该岗位已过期或下架。",
    JOB_PAGE_RATE_LIMITED: "岗位网站暂时限制访问，请稍后重试。", JOB_PAGE_UNRECOGNIZED: "无法识别为有效岗位页面。",
  };
  return messages[code];
}

@Controller("v1/job-imports")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class JobImportsController {
  constructor(
    @Inject(JOB_IMPORT_COMMANDS) private readonly commands: JobImportCommands,
    @Inject(JOB_IMPORT_QUERIES) private readonly queries: JobImportQueries,
    @Inject(JOB_PAGE_FETCHER) private readonly pageFetcher: JobPageFetcher,
  ) {}

  @Post()
  @ApiBody({ schema: {
    oneOf: [
      { type: "object", required: ["inputType", "content"], additionalProperties: false, properties: { inputType: { type: "string", enum: ["pasted_text"] }, content: { type: "string", minLength: 1, maxLength: 524288 } } },
      { type: "object", required: ["inputType", "originalFilename", "content"], additionalProperties: false, properties: { inputType: { type: "string", enum: ["markdown_upload"] }, originalFilename: { type: "string", pattern: "\\.md$" }, content: { type: "string", minLength: 1, maxLength: 524288 } } },
      { type: "object", required: ["inputType", "url"], additionalProperties: false, properties: { inputType: { type: "string", enum: ["url"] }, url: { type: "string", format: "uri" } } },
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
      const parsed = CreateJobImportCommandSchema.parse(command);
      const result = parsed.inputType === "url"
        ? await this.commands.submitFetchedUrl({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), command: parsed, page: await this.pageFetcher.fetch({ url: parsed.url }) })
        : await this.commands.submit({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), command: parsed });
      reply.status(result.reused ? HttpStatus.OK : HttpStatus.ACCEPTED);
      const { reused: _reused, ...response } = result;
      return response;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
      }
      if (error instanceof JobPageFetchError) throw new ApiException(error.code, HttpStatus.UNPROCESSABLE_ENTITY, pageErrorMessage(error.code));
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

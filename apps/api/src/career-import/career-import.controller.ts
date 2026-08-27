import { Controller, Get, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiConsumes, ApiNotFoundResponse, ApiPayloadTooLargeResponse, ApiServiceUnavailableResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { CareerImportError } from "@job-copilot/domain/career-imports";
import { CareerImportDetailSchema, CareerImportListSchema, CareerImportPathSchema, CreateCareerImportResponseSchema } from "@job-copilot/contracts/career-import";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { CAREER_IMPORT_COMMANDS, CAREER_IMPORT_QUERIES, type CareerImportCommands, type CareerImportQueries } from "./career-import.tokens.js";
import { CareerDocumentUploadError, parseCareerDocumentUpload } from "./parse-career-document-upload.js";

class CreateCareerImportResponseDto extends createZodDto(CreateCareerImportResponseSchema) {}
class CareerImportListDto extends createZodDto(CareerImportListSchema) {}
class CareerImportDetailDto extends createZodDto(CareerImportDetailSchema) {}
class CareerImportPathDto extends createZodDto(CareerImportPathSchema) {}

function uploadProblem(error: CareerDocumentUploadError): ApiException {
  const status = error.code === "CAREER_DOCUMENT_TOO_LARGE" ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST;
  const messages: Record<CareerDocumentUploadError["code"], string> = {
    CAREER_DOCUMENT_REQUIRED: "请选择一个 Markdown 文件",
    TOO_MANY_CAREER_DOCUMENTS: "一次只能上传一个 Markdown 文件",
    UNSUPPORTED_CAREER_DOCUMENT_TYPE: "仅支持 UTF-8 Markdown 文件",
    CAREER_DOCUMENT_TOO_LARGE: "Markdown 文件不能超过 512 KiB",
    CAREER_DOCUMENT_INVALID_UTF8: "Markdown 文件必须使用 UTF-8 编码",
    CAREER_DOCUMENT_EMPTY: "Markdown 文件不能为空",
  };
  return new ApiException(error.code, status, messages[error.code]);
}

@Controller("v1/career-documents/imports")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class CareerImportController {
  constructor(
    @Inject(CAREER_IMPORT_COMMANDS) private readonly commands: CareerImportCommands,
    @Inject(CAREER_IMPORT_QUERIES) private readonly queries: CareerImportQueries,
  ) {}

  @Post()
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: {
    type: "object", required: ["file"], additionalProperties: false,
    properties: { file: { type: "string", format: "binary", description: "UTF-8 Markdown，最大 512 KiB" } },
  } })
  @ZodResponse({ type: CreateCareerImportResponseDto, status: HttpStatus.OK })
  @ZodResponse({ type: CreateCareerImportResponseDto, status: HttpStatus.ACCEPTED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiPayloadTooLargeResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiServiceUnavailableResponse({ type: ApiProblem })
  async create(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    let upload;
    try {
      upload = await parseCareerDocumentUpload(request.parts());
    } catch (error) {
      if (error instanceof CareerDocumentUploadError) throw uploadProblem(error);
      throw error;
    }
    try {
      const result = await this.commands.createOrReuse({
        userId: request.authenticatedAccount!.userId,
        requestId: getRequestId(request),
        ...upload,
      });
      reply.status(result.shouldReturnAccepted ? HttpStatus.ACCEPTED : HttpStatus.OK);
      const { shouldReturnAccepted: _shouldReturnAccepted, ...response } = result;
      return response;
    } catch (error) {
      if (error instanceof CareerImportError) {
        throw new ApiException(error.code, HttpStatus.SERVICE_UNAVAILABLE, "导入任务暂时不可用，请稍后重试");
      }
      throw new ApiException("CAREER_DOCUMENT_STORAGE_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE, "职业资料暂时无法保存，请稍后重试");
    }
  }

  @Get()
  @ZodResponse({ type: CareerImportListDto })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async list(@Req() request: FastifyRequest) {
    return { imports: await this.queries.list({ userId: request.authenticatedAccount!.userId }) };
  }

  @Get(":importId")
  @ZodResponse({ type: CareerImportDetailDto })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async get(@Req() request: FastifyRequest, @Param() params: CareerImportPathDto) {
    const result = await this.queries.get({ userId: request.authenticatedAccount!.userId, importId: params.importId });
    if (!result) throw new ApiException("CAREER_IMPORT_NOT_FOUND", HttpStatus.NOT_FOUND, "职业资料导入不存在");
    return result;
  }
}

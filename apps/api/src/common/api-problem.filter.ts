import { Catch, type ArgumentsHost, HttpException, HttpStatus } from "@nestjs/common";
import type { ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "@job-copilot/domain/workbench-home";
import { getRequestId } from "./request-id.hook.js";

export class ApiException extends HttpException {
  constructor(
    public readonly code: string,
    status: HttpStatus,
    public readonly publicMessage: string,
    public readonly details?: { dependencies: Record<string, "ready" | "not_ready"> },
  ) {
    super(code, status);
  }
}

function getProblem(exception: unknown): {
  status: HttpStatus;
  code: string;
  message: string;
  details?: { dependencies: Record<string, "ready" | "not_ready"> };
} {
  if (typeof exception === "object" && exception !== null && "code" in exception) {
    const code = (exception as { code?: unknown }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") {
      return { status: HttpStatus.PAYLOAD_TOO_LARGE, code: "CAREER_DOCUMENT_TOO_LARGE", message: "职业资料不能超过 512 KiB" };
    }
    if (code === "FST_FIELDS_LIMIT") {
      return { status: HttpStatus.BAD_REQUEST, code: "CAREER_DOCUMENT_REQUIRED", message: "请选择一份 Markdown 或 DOCX 职业资料" };
    }
    if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT") {
      return { status: HttpStatus.BAD_REQUEST, code: "TOO_MANY_CAREER_DOCUMENTS", message: "一次只能上传一份 Markdown 或 DOCX 职业资料" };
    }
  }
  if (exception instanceof ApiException) {
    return {
      status: exception.getStatus(),
      code: exception.code,
      message: exception.publicMessage,
      details: exception.details,
    };
  }
  if (exception instanceof DomainError) {
    return { status: HttpStatus.NOT_FOUND, code: exception.code, message: "求职账户不存在" };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === HttpStatus.BAD_REQUEST) {
      return { status, code: "INVALID_REQUEST", message: "请求无效" };
    }
    if (status === HttpStatus.NOT_FOUND) {
      return { status, code: "RESOURCE_NOT_FOUND", message: "资源不存在" };
    }
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: "INTERNAL_ERROR", message: "服务暂时不可用" };
}

@Catch()
export class ApiProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const problem = getProblem(exception);
    reply.status(problem.status).send({
      code: problem.code,
      message: problem.message,
      requestId: getRequestId(request),
      ...problem.details,
    });
  }
}

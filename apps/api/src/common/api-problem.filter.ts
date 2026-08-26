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
  ) {
    super(code, status);
  }
}

function getProblem(exception: unknown): { status: HttpStatus; code: string; message: string } {
  if (exception instanceof ApiException) {
    return { status: exception.getStatus(), code: exception.code, message: exception.publicMessage };
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
    });
  }
}

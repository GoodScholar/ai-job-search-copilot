import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import {
  AgentInboxActionCommandSchema,
  AgentInboxActionResponseSchema,
  AgentInboxListSchema,
} from "@job-copilot/contracts/agent-inbox";
import { AgentInboxError } from "@job-copilot/domain/agent-runs";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse, ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { runPreflightConflict } from "../run-preflight/run-preflight-error.js";
import { AGENT_INBOX, type AgentInbox } from "./agent-inbox.tokens.js";

class AgentInboxListDto extends createZodDto(AgentInboxListSchema) {}
const AgentInboxActionCommandDto = createZodDto(AgentInboxActionCommandSchema);
Object.defineProperty(AgentInboxActionCommandDto, "name", { value: "AgentInboxActionCommandDto" });
class AgentInboxActionResponseDto extends createZodDto(AgentInboxActionResponseSchema) {}
class AgentInboxPathDto extends createZodDto(z.object({ itemId: z.uuid() }).strict()) {}
class AgentInboxListQueryDto extends createZodDto(z.object({ status: z.enum(["unread", "read", "resolved", "pending"]).default("pending") }).strict()) {}

function inboxProblem(error: AgentInboxError): ApiException {
  if (error.code === "AGENT_INBOX_NOT_FOUND") {
    return new ApiException("AGENT_INBOX_ITEM_NOT_FOUND", HttpStatus.NOT_FOUND, "Agent Inbox 事项不存在");
  }
  if (error.code === "AGENT_INBOX_ACTION_CONFLICT") {
    return new ApiException(error.code, HttpStatus.CONFLICT, "Agent Inbox 事项状态已变化，请刷新后重试");
  }
  throw error;
}

@Controller("v1/agent-inbox")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class AgentInboxController {
  constructor(@Inject(AGENT_INBOX) private readonly inbox: AgentInbox) {}

  @Get()
  @ZodResponse({ type: AgentInboxListDto })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  list(@Req() request: FastifyRequest, @Query() query: AgentInboxListQueryDto) {
    return this.inbox.list({ userId: request.authenticatedAccount!.userId, status: query.status });
  }

  @Post(":itemId/actions")
  @ApiBody({ type: AgentInboxActionCommandDto })
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: AgentInboxActionResponseDto })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async act(
    @Req() request: FastifyRequest,
    @Param() params: AgentInboxPathDto,
    @Body(new ZodValidationPipe(AgentInboxActionCommandDto)) command: z.infer<typeof AgentInboxActionCommandSchema>,
  ) {
    try {
      return await this.inbox.act({
        userId: request.authenticatedAccount!.userId,
        requestId: getRequestId(request),
        itemId: params.itemId,
        command: AgentInboxActionCommandSchema.parse(command),
      });
    } catch (error) {
      if (error instanceof RunPreflightRejectedError) throw runPreflightConflict(error);
      if (error instanceof AgentInboxError) throw inboxProblem(error);
      throw error;
    }
  }
}

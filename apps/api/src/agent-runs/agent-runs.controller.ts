import { Readable } from "node:stream";
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiServiceUnavailableResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import {
  AgentRunDetailSchema,
  ControlAgentRunCommandSchema,
  ControlAgentRunResponseSchema,
  LatestAgentRunResponseSchema,
  StartAgentRunCommandSchema,
  StartAgentRunResponseSchema,
  isAgentRunTerminalEvent,
  type AgentRunDetail,
} from "@job-copilot/contracts/agent-runs";
import { AgentRunControlError, AgentRunError } from "@job-copilot/domain/agent-runs";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { createAgentRunEventStream, resolveAgentRunEventCursor } from "./agent-run-event-stream.js";
import { AGENT_RUN_COMMANDS, AGENT_RUN_QUERIES, type AgentRunCommands, type AgentRunQueries } from "./agent-runs.tokens.js";
import { RunPreflightController } from "../run-preflight/run-preflight.controller.js";

class StartAgentRunCommandDto extends createZodDto(StartAgentRunCommandSchema) {}
class ControlAgentRunCommandDto extends createZodDto(ControlAgentRunCommandSchema) {}
class ControlAgentRunResponseDto extends createZodDto(ControlAgentRunResponseSchema) {}
const StartAgentRunResponseDto = createZodDto(StartAgentRunResponseSchema);
Object.defineProperty(StartAgentRunResponseDto, "name", { value: "StartAgentRunResponseDto" });
const AgentRunDetailDto = createZodDto(AgentRunDetailSchema);
Object.defineProperty(AgentRunDetailDto, "name", { value: "AgentRunDetailDto" });
class LatestAgentRunResponseDto extends createZodDto(LatestAgentRunResponseSchema) {}
class AgentRunPathDto extends createZodDto(z.object({ runId: z.uuid() }).strict()) {}
class AgentRunEventsQueryDto extends createZodDto(z.object({ afterEventId: z.string().optional() }).strict()) {}

function notFound(code = "AGENT_RUN_NOT_FOUND", message = "Agent 运行不存在"): ApiException {
  return new ApiException(code, HttpStatus.NOT_FOUND, message);
}

function mapStartError(error: AgentRunError): ApiException {
  if (error.code === "AGENT_RUN_UNAVAILABLE") {
    return new ApiException(error.code, HttpStatus.SERVICE_UNAVAILABLE, "Agent 运行暂时不可用，请稍后重试");
  }
  return notFound(error.code, error.code === "AGENT_RUN_TARGET_INACTIVE" ? "求职目标不可用" : "求职目标不存在");
}

function mapControlError(error: AgentRunControlError): ApiException {
  if (error.code === "AGENT_RUN_NOT_FOUND") return notFound(error.code);
  if (error.code === "AGENT_RUN_COMMAND_ID_CONFLICT" || error.code === "AGENT_RUN_CONTROL_CONFLICT") {
    return new ApiException(error.code, HttpStatus.CONFLICT, "Agent 运行状态已变化，请刷新后重试");
  }
  throw error;
}

function publicDetail(run: AgentRunDetail): AgentRunDetail {
  return AgentRunDetailSchema.parse(run);
}

@Controller("v1/agent-runs")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class AgentRunsController {
  constructor(
    @Inject(AGENT_RUN_COMMANDS) private readonly commands: AgentRunCommands,
    @Inject(AGENT_RUN_QUERIES) private readonly queries: AgentRunQueries,
  ) {}

  @Post()
  @ZodResponse({ type: StartAgentRunResponseDto, status: HttpStatus.CREATED })
  @ZodResponse({ type: StartAgentRunResponseDto, status: HttpStatus.OK })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiServiceUnavailableResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  async start(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() command: StartAgentRunCommandDto,
  ) {
    try {
      const result = await this.commands.start({
        userId: request.authenticatedAccount!.userId,
        requestId: getRequestId(request),
        command,
      });
      const response = StartAgentRunResponseSchema.parse(result);
      reply.status(response.reused ? HttpStatus.OK : HttpStatus.CREATED);
      return response;
    } catch (error) {
      if (error instanceof RunPreflightRejectedError) throw RunPreflightController.preflightConflict(error);
      if (error instanceof AgentRunError) throw mapStartError(error);
      throw error;
    }
  }

  @Post(":runId/controls")
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: ControlAgentRunResponseDto })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async control(
    @Req() request: FastifyRequest,
    @Param() params: AgentRunPathDto,
    @Body() command: ControlAgentRunCommandDto,
  ) {
    try {
      return await this.commands.control({
        userId: request.authenticatedAccount!.userId,
        requestId: getRequestId(request),
        runId: params.runId,
        command,
      });
    } catch (error) {
      if (error instanceof AgentRunControlError) throw mapControlError(error);
      throw error;
    }
  }

  @Get("latest")
  @ZodResponse({ type: LatestAgentRunResponseDto })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async latest(@Req() request: FastifyRequest) {
    const result = await this.queries.latest({ userId: request.authenticatedAccount!.userId });
    return LatestAgentRunResponseSchema.parse({ run: result.run ? publicDetail(result.run) : null });
  }

  @Get(":runId/events")
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async events(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param() params: AgentRunPathDto,
    @Query() query: AgentRunEventsQueryDto,
    @Headers("last-event-id") lastEventId: string | undefined,
  ): Promise<void> {
    const userId = request.authenticatedAccount!.userId;
    const owned = await this.queries.get({ userId, runId: params.runId });
    if (!owned) throw notFound();

    let afterSequence: number;
    try {
      afterSequence = resolveAgentRunEventCursor({ lastEventId, afterEventId: query.afterEventId });
    } catch (error) {
      if (error instanceof z.ZodError) throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
      throw error;
    }

    const abort = new AbortController();
    request.raw.once("aborted", () => abort.abort());
    reply.raw.once("close", () => abort.abort());
    const latestEvent = owned.events.at(-1);
    const stream = createAgentRunEventStream({
      queries: this.queries,
      userId,
      runId: params.runId,
      afterSequence,
      terminalSequence: latestEvent && isAgentRunTerminalEvent(latestEvent.eventType) ? latestEvent.sequence : undefined,
      signal: abort.signal,
    });
    reply
      .header("Content-Type", "text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-transform")
      .header("Connection", "keep-alive")
      .send(Readable.fromWeb(stream as import("node:stream/web").ReadableStream<Uint8Array>));
  }

  @Get(":runId")
  @ZodResponse({ type: AgentRunDetailDto })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async get(@Req() request: FastifyRequest, @Param() params: AgentRunPathDto) {
    const run = await this.queries.get({ userId: request.authenticatedAccount!.userId, runId: params.runId });
    if (!run) throw notFound();
    return AgentRunDetailSchema.parse(publicDetail(run));
  }
}

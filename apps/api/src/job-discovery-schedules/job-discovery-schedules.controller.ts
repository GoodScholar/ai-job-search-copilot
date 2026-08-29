import { Body, Controller, Get, HttpStatus, Inject, Param, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { JobDiscoveryScheduleResponseSchema, SetJobDiscoveryScheduleCommandSchema } from "@job-copilot/contracts/job-discovery-schedules";
import { JobDiscoveryScheduleError } from "@job-copilot/domain/job-discovery-schedules";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { JOB_DISCOVERY_SCHEDULES, type JobDiscoverySchedules } from "./job-discovery-schedules.tokens.js";

class JobDiscoveryScheduleResponseDto extends createZodDto(JobDiscoveryScheduleResponseSchema) {}
class JobDiscoverySchedulePathDto extends createZodDto(z.object({ targetId: z.uuid() }).strict()) {}
class SetJobDiscoveryScheduleCommandDto extends createZodDto(SetJobDiscoveryScheduleCommandSchema) {}

function scheduleProblem(error: unknown): never {
  if (!(error instanceof JobDiscoveryScheduleError)) throw error;
  switch (error.code) {
    case "JOB_DISCOVERY_SCHEDULE_TARGET_NOT_FOUND": throw new ApiException(error.code, HttpStatus.NOT_FOUND, "求职目标不存在");
    case "JOB_DISCOVERY_SCHEDULE_TARGET_INACTIVE": throw new ApiException(error.code, HttpStatus.CONFLICT, "已停用的求职目标不能启用每日检查");
    case "JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT": throw new ApiException(error.code, HttpStatus.CONFLICT, "每日检查已在其他位置更新，请刷新后重试");
    case "SOURCE_POLICY_REQUIRED": throw new ApiException(error.code, HttpStatus.CONFLICT, "需允许 boards-api.greenhouse.io");
    case "NO_SUPPORTED_SOURCE": throw new ApiException(error.code, HttpStatus.CONFLICT, "待接入");
  }
}

@Controller("v1/job-targets/:targetId/discovery-schedule")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class JobDiscoverySchedulesController {
  constructor(@Inject(JOB_DISCOVERY_SCHEDULES) private readonly schedules: JobDiscoverySchedules) {}

  @Get()
  @ZodResponse({ type: JobDiscoveryScheduleResponseDto, status: HttpStatus.OK })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async get(@Req() request: FastifyRequest, @Param() params: JobDiscoverySchedulePathDto) {
    try {
      const response = await this.schedules.get({ userId: request.authenticatedAccount!.userId, targetId: params.targetId });
      if (!response) throw new JobDiscoveryScheduleError("JOB_DISCOVERY_SCHEDULE_TARGET_NOT_FOUND");
      return response;
    }
    catch (error) { scheduleProblem(error); }
  }

  @Put()
  @ZodResponse({ type: JobDiscoveryScheduleResponseDto, status: HttpStatus.OK })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async set(@Req() request: FastifyRequest, @Param() params: JobDiscoverySchedulePathDto, @Body() command: SetJobDiscoveryScheduleCommandDto) {
    try {
      const schedule = await this.schedules.set({ userId: request.authenticatedAccount!.userId, targetId: params.targetId, requestId: getRequestId(request), command });
      const response = await this.schedules.get({ userId: request.authenticatedAccount!.userId, targetId: params.targetId });
      if (!response) throw new JobDiscoveryScheduleError("JOB_DISCOVERY_SCHEDULE_TARGET_NOT_FOUND");
      return JobDiscoveryScheduleResponseSchema.parse({ schedule, sourceSupport: response.sourceSupport });
    } catch (error) { scheduleProblem(error); }
  }
}

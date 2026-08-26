import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { DATABASE } from "../config/runtime-config.module.js";
import { getWorkbenchHome } from "@job-copilot/domain/workbench-home";
import type { Database } from "@job-copilot/database";
import { WorkbenchHomeSchema } from "@job-copilot/contracts/workbench";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";

class WorkbenchHomeDto extends createZodDto(WorkbenchHomeSchema) {}

@Controller("v1/workbench")
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class WorkbenchController {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  @Get("home")
  @ZodResponse({ type: WorkbenchHomeDto })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  getHome(@Req() request: FastifyRequest) {
    return getWorkbenchHome({ db: this.database, userId: request.authenticatedAccount!.userId });
  }
}

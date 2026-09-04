import { Controller, Get, Header, Inject, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { WorkbenchHomeSchema } from "@job-copilot/contracts/workbench";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { WORKBENCH_HOME, type WorkbenchHomeService } from "./workbench.tokens.js";

class WorkbenchHomeDto extends createZodDto(WorkbenchHomeSchema) {}

@Controller("v1/workbench")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class WorkbenchController {
  constructor(@Inject(WORKBENCH_HOME) private readonly getWorkbenchHome: WorkbenchHomeService) {}

  @Get("home")
  @Header("Cache-Control", "no-store")
  @ZodResponse({ type: WorkbenchHomeDto })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  getHome(@Req() request: FastifyRequest) {
    return this.getWorkbenchHome({ userId: request.authenticatedAccount!.userId });
  }
}

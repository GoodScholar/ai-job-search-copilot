import { Body, Controller, Delete, Headers, HttpCode, HttpStatus, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiForbiddenResponse, ApiNoContentResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { ApiProblemSchema } from "@job-copilot/contracts/api-problem";
import { StartDevSessionRequestSchema, StartDevSessionResponseSchema } from "@job-copilot/contracts/auth";
import type { RuntimeConfig } from "@job-copilot/domain/runtime-config";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { RUNTIME_CONFIG } from "../config/runtime-config.module.js";
import { ACCOUNT_SESSIONS, type AccountSessions } from "./auth.tokens.js";
import { SessionGuard } from "./session.guard.js";

class StartDevSessionDto extends createZodDto(StartDevSessionRequestSchema) {}
class StartDevSessionResponseDto extends createZodDto(StartDevSessionResponseSchema) {}
export class ApiProblem extends createZodDto(ApiProblemSchema) {}

function hasValidDevSecret(secret: string | undefined, config: RuntimeConfig): boolean {
  return config.AUTH_MODE === "dev"
    && (config.APP_ENV === "local" || config.APP_ENV === "test")
    && secret === config.DEV_AUTH_SHARED_SECRET;
}

@Controller("v1/auth")
export class AuthController {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(ACCOUNT_SESSIONS) private readonly sessions: AccountSessions,
  ) {}

  @Post("dev/sessions")
  @ApiBody({ type: StartDevSessionDto })
  @ZodResponse({ type: StartDevSessionResponseDto, status: HttpStatus.CREATED })
  @ApiForbiddenResponse({ type: ApiProblem })
  async startDevSession(
    @Body() body: StartDevSessionDto,
    @Headers("x-dev-auth-secret") secret: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    if (!hasValidDevSecret(secret, this.config)) {
      throw new ApiException("DEV_AUTH_DISABLED", HttpStatus.FORBIDDEN, "Dev Auth 不可用");
    }
    const session = await this.sessions.startDevSession({
      subject: body.subject,
      now: new Date(),
      requestId: getRequestId(request),
    });
    return { ...session, expiresAt: session.expiresAt.toISOString() };
  }

  @Delete("sessions/current")
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async endCurrentSession(@Req() request: FastifyRequest): Promise<void> {
    const authorization = request.headers.authorization;
    const sessionToken = typeof authorization === "string" ? authorization.slice("Bearer ".length) : "";
    await this.sessions.endSession({ sessionToken, now: new Date(), requestId: getRequestId(request) });
  }
}

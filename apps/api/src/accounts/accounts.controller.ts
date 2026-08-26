import { Controller, Get, HttpStatus, Inject, Param, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { AccountPathSchema, AccountProjectionSchema } from "@job-copilot/contracts/auth";
import type { AuditTrail } from "@job-copilot/domain/audit-trail";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { ApiException } from "../common/api-problem.filter.js";
import { ApiProblem } from "../auth/auth.controller.js";
import { AUDIT_TRAIL } from "../auth/auth.module.js";
import { SessionGuard } from "../auth/session.guard.js";

class AccountPathDto extends createZodDto(AccountPathSchema) {}
class AccountProjectionDto extends createZodDto(AccountProjectionSchema) {}

@Controller("v1/accounts")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class AccountsController {
  constructor(@Inject(AUDIT_TRAIL) private readonly auditTrail: AuditTrail) {}

  @Get(":userId")
  @ZodResponse({ type: AccountProjectionDto })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async getCurrentAccount(@Param() params: AccountPathDto, @Req() request: FastifyRequest) {
    if (params.userId !== request.authenticatedAccount?.userId) {
      await this.auditTrail.append({
        userId: request.authenticatedAccount?.userId,
        actorUserId: request.authenticatedAccount?.userId,
        eventType: "account.access_rejected",
        requestId: request.requestId,
        outcome: "denied",
        reasonCode: "ACCOUNT_NOT_FOUND",
        resourceType: "account",
        resourceId: params.userId,
        metadata: {},
      });
      throw new ApiException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND, "求职账户不存在");
    }
    return { account: { userId: request.authenticatedAccount.userId } };
  }
}

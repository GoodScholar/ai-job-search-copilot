import { Body, Controller, Get, HttpStatus, Inject, Param, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConflictResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { accountRunPolicyProblemFromZodIssues, AccountRunPolicyCommandSchema, AccountRunPolicyHistorySchema, AccountRunPolicyResponseSchema } from "@job-copilot/contracts/account-run-policies";
import { AccountRunPolicyError } from "@job-copilot/domain/account-run-policies";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { ZodError } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { ACCOUNT_RUN_POLICIES, type AccountRunPolicies } from "./account-run-policies.tokens.js";

class PolicyResponseDto extends createZodDto(AccountRunPolicyResponseSchema) {}
class PolicyHistoryDto extends createZodDto(AccountRunPolicyHistorySchema) {}
const revisionPath = /^[0-9]+$/u;
function policyProblem(error: unknown): never {
  if (error instanceof AccountRunPolicyError) throw new ApiException(error.code, HttpStatus.CONFLICT, "账户运行策略已在其他位置更新，请刷新后重试", { issues: [] });
  if (!(error instanceof ZodError)) throw error;
  const problem = accountRunPolicyProblemFromZodIssues(error.issues);
  if (!problem) throw new ApiException("INVALID_REQUEST", HttpStatus.BAD_REQUEST, "请求无效");
  throw new ApiException(problem.code, HttpStatus.BAD_REQUEST, problem.message, { issues: problem.issues });
}

@Controller("v1/account/run-policy")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class AccountRunPoliciesController {
  constructor(@Inject(ACCOUNT_RUN_POLICIES) private readonly policies: AccountRunPolicies) {}
  @Get() @ZodResponse({ type: PolicyResponseDto }) @ApiUnauthorizedResponse({ type: ApiProblem })
  async get(@Req() request: FastifyRequest) { return this.policies.get({ userId: request.authenticatedAccount!.userId }); }
  @Get("history") @ZodResponse({ type: PolicyHistoryDto }) @ApiUnauthorizedResponse({ type: ApiProblem })
  async history(@Req() request: FastifyRequest) { return this.policies.history({ userId: request.authenticatedAccount!.userId }); }
  @Get("history/:revisionNumber") @ZodResponse({ type: PolicyResponseDto })
  async revision(@Req() request: FastifyRequest, @Param("revisionNumber") revisionNumber: string) {
    if (!revisionPath.test(revisionNumber)) throw new ApiException("RESOURCE_NOT_FOUND", HttpStatus.NOT_FOUND, "策略修订不存在");
    const result = await this.policies.getRevision({ userId: request.authenticatedAccount!.userId, revisionNumber: Number(revisionNumber) });
    if (!result) throw new ApiException("RESOURCE_NOT_FOUND", HttpStatus.NOT_FOUND, "策略修订不存在");
    return result;
  }
  @Put() @ZodResponse({ type: PolicyResponseDto }) @ApiConflictResponse({ type: ApiProblem }) @ApiUnauthorizedResponse({ type: ApiProblem })
  async save(@Req() request: FastifyRequest, @Body() command: unknown) {
    try { return await this.policies.save({ userId: request.authenticatedAccount!.userId, command: AccountRunPolicyCommandSchema.parse(command) }); }
    catch (error) { return policyProblem(error); }
  }
}

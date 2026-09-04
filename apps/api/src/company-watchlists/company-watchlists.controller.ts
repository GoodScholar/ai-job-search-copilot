import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import {
  AddCompanyWatchlistItemCommandSchema,
  CompanyWatchlistOverviewSchema,
  ReorderCompanyWatchlistCommandSchema,
  ReviseCompanyWatchlistItemCommandSchema,
  SetCompanyWatchlistItemStateCommandSchema,
} from "@job-copilot/contracts/company-watchlists";
import { CompanyWatchlistError } from "@job-copilot/domain/company-watchlists";
import type { FastifyRequest } from "fastify";
import { createZodDto, ZodResponse } from "nestjs-zod";
import { z } from "zod";
import { ApiProblem } from "../auth/auth.controller.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import {
  COMPANY_WATCHLIST_COMMANDS,
  COMPANY_WATCHLIST_QUERIES,
  type CompanyWatchlistCommands,
  type CompanyWatchlistQueries,
} from "./company-watchlists.tokens.js";

class CompanyWatchlistOverviewDto extends createZodDto(CompanyWatchlistOverviewSchema) {}
class CompanyWatchlistTargetPathDto extends createZodDto(z.object({ targetId: z.uuid() }).strict()) {}
class CompanyWatchlistItemPathDto extends createZodDto(z.object({ targetId: z.uuid(), itemId: z.uuid() }).strict()) {}
class AddCompanyWatchlistItemCommandDto extends createZodDto(AddCompanyWatchlistItemCommandSchema) {}
class ReviseCompanyWatchlistItemCommandDto extends createZodDto(ReviseCompanyWatchlistItemCommandSchema) {}
class ReorderCompanyWatchlistCommandDto extends createZodDto(ReorderCompanyWatchlistCommandSchema) {}
class SetCompanyWatchlistItemStateCommandDto extends createZodDto(SetCompanyWatchlistItemStateCommandSchema) {}

function companyWatchlistProblem(error: unknown): never {
  if (!(error instanceof CompanyWatchlistError)) throw error;
  switch (error.code) {
    case "COMPANY_WATCHLIST_TARGET_NOT_FOUND":
      throw new ApiException(error.code, HttpStatus.NOT_FOUND, "求职目标不存在");
    case "COMPANY_WATCHLIST_ITEM_NOT_FOUND":
      throw new ApiException(error.code, HttpStatus.NOT_FOUND, "目标公司 Watchlist 项不存在");
    case "COMPANY_WATCHLIST_VERSION_CONFLICT":
      throw new ApiException(error.code, HttpStatus.CONFLICT, "目标公司 Watchlist 已在其他位置更新，请刷新后重试");
    case "COMPANY_WATCHLIST_LIMIT":
      throw new ApiException(error.code, HttpStatus.CONFLICT, "目标公司 Watchlist 已达上限");
    case "COMPANY_WATCHLIST_DUPLICATE_COMPANY":
      throw new ApiException(error.code, HttpStatus.CONFLICT, "目标公司 Watchlist 中已存在该公司");
    case "COMPANY_WATCHLIST_DUPLICATE_SOURCE":
      throw new ApiException(error.code, HttpStatus.CONFLICT, "目标公司 Watchlist 中已存在该岗位来源");
    case "COMPANY_WATCHLIST_TARGET_INACTIVE":
      throw new ApiException(error.code, HttpStatus.CONFLICT, "已停用的求职目标不能维护目标公司 Watchlist");
  }
}

@Controller("v1/job-targets/:targetId/company-watchlist")
@UseGuards(SessionGuard)
@ApiBearerAuth("bearerAuth")
export class CompanyWatchlistsController {
  constructor(
    @Inject(COMPANY_WATCHLIST_COMMANDS) private readonly commands: CompanyWatchlistCommands,
    @Inject(COMPANY_WATCHLIST_QUERIES) private readonly queries: CompanyWatchlistQueries,
  ) {}

  @Get()
  @ZodResponse({ type: CompanyWatchlistOverviewDto, status: HttpStatus.OK })
  @ApiNotFoundResponse({ type: ApiProblem })
  @ApiUnauthorizedResponse({ type: ApiProblem })
  async get(@Req() request: FastifyRequest, @Param() params: CompanyWatchlistTargetPathDto) {
    try {
      return await this.queries.get({ userId: request.authenticatedAccount!.userId, targetId: params.targetId });
    } catch (error) {
      companyWatchlistProblem(error);
    }
  }

  @Post("items")
  @ZodResponse({ type: CompanyWatchlistOverviewDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async addItem(@Req() request: FastifyRequest, @Param() params: CompanyWatchlistTargetPathDto, @Body() command: AddCompanyWatchlistItemCommandDto) {
    try {
      return await this.commands.addItem({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), targetId: params.targetId, command });
    } catch (error) {
      companyWatchlistProblem(error);
    }
  }

  @Post("items/:itemId/revisions")
  @ZodResponse({ type: CompanyWatchlistOverviewDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async reviseItem(@Req() request: FastifyRequest, @Param() params: CompanyWatchlistItemPathDto, @Body() command: ReviseCompanyWatchlistItemCommandDto) {
    try {
      return await this.commands.reviseItem({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), targetId: params.targetId, itemId: params.itemId, command });
    } catch (error) {
      companyWatchlistProblem(error);
    }
  }

  @Post("items/:itemId/state-changes")
  @ZodResponse({ type: CompanyWatchlistOverviewDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async setItemState(@Req() request: FastifyRequest, @Param() params: CompanyWatchlistItemPathDto, @Body() command: SetCompanyWatchlistItemStateCommandDto) {
    try {
      return await this.commands.setItemState({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), targetId: params.targetId, itemId: params.itemId, command });
    } catch (error) {
      companyWatchlistProblem(error);
    }
  }

  @Post("reorders")
  @ZodResponse({ type: CompanyWatchlistOverviewDto, status: HttpStatus.CREATED })
  @ApiBadRequestResponse({ type: ApiProblem })
  @ApiConflictResponse({ type: ApiProblem })
  @ApiNotFoundResponse({ type: ApiProblem })
  async reorder(@Req() request: FastifyRequest, @Param() params: CompanyWatchlistTargetPathDto, @Body() command: ReorderCompanyWatchlistCommandDto) {
    try {
      return await this.commands.reorder({ userId: request.authenticatedAccount!.userId, requestId: getRequestId(request), targetId: params.targetId, command });
    } catch (error) {
      companyWatchlistProblem(error);
    }
  }
}

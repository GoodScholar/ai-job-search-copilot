import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedAccount } from "@job-copilot/domain/account-sessions";
import { ApiException } from "../common/api-problem.filter.js";
import { getRequestId } from "../common/request-id.hook.js";
import { ACCOUNT_SESSIONS, type AccountSessions } from "./auth.tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    authenticatedAccount?: AuthenticatedAccount;
  }
}

function readOpaqueBearerToken(authorization: string | string[] | undefined): string | null {
  if (typeof authorization !== "string") {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match?.[1] ?? null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(ACCOUNT_SESSIONS) private readonly sessions: AccountSessions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const sessionToken = readOpaqueBearerToken(request.headers.authorization);
    if (!sessionToken) {
      throw new ApiException("AUTH_REQUIRED", 401, "需要有效会话");
    }

    const account = await this.sessions.authenticateSession({
      sessionToken,
      now: new Date(),
      requestId: getRequestId(request),
    });
    if (!account) {
      throw new ApiException("AUTH_REQUIRED", 401, "需要有效会话");
    }

    request.authenticatedAccount = account;
    return true;
  }
}

import "server-only";

import { randomUUID } from "node:crypto";
import { ApiProblemSchema, type ApiProblem } from "@job-copilot/contracts/api-problem";
import {
  StartDevSessionRequestSchema,
  StartDevSessionResponseSchema,
  type StartDevSessionRequest,
} from "@job-copilot/contracts/auth";
import {
  CareerImportDetailSchema,
  CareerImportListSchema,
  CreateCareerImportResponseSchema,
  type CareerImportDetail,
  type CareerImportList,
  type CreateCareerImportResponse,
  type ResolveCareerFactConflictCommand,
  ResolveCareerFactConflictResponseSchema,
} from "@job-copilot/contracts/career-import";
import {
  ProfileSnapshotSchema,
  type CandidateFactDecisionCommand,
  type CreateProfileFactCommand,
  type ProfileSnapshot,
  type RemoveProfileFactCommand,
  type ReviseProfileFactCommand,
} from "@job-copilot/contracts/profile-review";
import {
  JobTargetOverviewSchema,
  type CreateJobTargetCommand,
  type DeactivateJobTargetCommand,
  type JobTargetOverview,
  type ReviseJobTargetCommand,
} from "@job-copilot/contracts/job-targets";
import {
  CompanyWatchlistOverviewSchema,
  type AddCompanyWatchlistItemCommand,
  type CompanyWatchlistOverview,
  type ReorderCompanyWatchlistCommand,
  type ReviseCompanyWatchlistItemCommand,
  type SetCompanyWatchlistItemStateCommand,
} from "@job-copilot/contracts/company-watchlists";
import {
  CreateJobImportCommandSchema,
  CreateJobImportResponseSchema,
  JobImportDetailSchema,
  JobImportListSchema,
  type CreateJobImportCommand,
  type CreateJobImportResponse,
  type JobImportDetail,
  type JobImportList,
} from "@job-copilot/contracts/job-imports";
import {
  CreateJobTriageVersionCommandSchema,
  JobTriageVersionSchema,
  type CreateJobTriageVersionCommand,
  type JobTriageVersion,
} from "@job-copilot/contracts/job-triage";
import { WorkbenchHomeSchema, type WorkbenchHome } from "@job-copilot/contracts/workbench";
import {
  AgentRunDetailSchema,
  JobSourceHealthOverviewSchema,
  AgentRunSseCursorSchema,
  ControlAgentRunCommandSchema,
  ControlAgentRunResponseSchema,
  LatestAgentRunResponseSchema,
  StartAgentRunCommandSchema,
  StartAgentRunResponseSchema,
  type AgentRunDetail,
  type JobSourceHealthOverview,
  type ControlAgentRunCommand,
  type ControlAgentRunResponse,
  type StartAgentRunCommand,
  type StartAgentRunResponse,
} from "@job-copilot/contracts/agent-runs";
import {
  JobDiscoveryScheduleResponseSchema,
  SetJobDiscoveryScheduleCommandSchema,
  type JobDiscoveryScheduleResponse,
  type SetJobDiscoveryScheduleCommand,
} from "@job-copilot/contracts/job-discovery-schedules";
import {
  AgentInboxActionCommandSchema,
  AgentInboxActionResponseSchema,
  AgentInboxListSchema,
  AgentInboxStatusSchema,
  type AgentInboxActionCommand,
  type AgentInboxActionResponse,
} from "@job-copilot/contracts/agent-inbox";
import { z } from "zod";
import { RecommendationDecisionCommandSchema, RecommendationExclusionPageSchema, RecommendationListHistoryPageSchema, RecommendationListSchema, type RecommendationDecisionCommand, type RecommendationExclusionPage, type RecommendationList, type RecommendationListHistoryPage } from "@job-copilot/contracts/recommendations";

type ApiClientConfig = {
  apiInternalUrl: string;
  devAuthSharedSecret: string;
  fetchImpl?: typeof fetch;
};

type ApiErrorKind = "api" | "invalid_response" | "network" | "configuration";

export class ApiClientError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly problem?: ApiProblem,
  ) {
    super(message);
  }
}

function apiUrl(apiInternalUrl: string, path: string): string {
  if (!apiInternalUrl) {
    throw new ApiClientError("configuration", "API_INTERNAL_URL 未配置");
  }

  try {
    return new URL(path, apiInternalUrl).toString();
  } catch {
    throw new ApiClientError("configuration", "API_INTERNAL_URL 无效");
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiClientError("invalid_response", "API 返回了无效响应", response.status);
  }
}

async function readProblem(response: Response): Promise<ApiProblem | null> {
  const payload = await parseJson(response).catch((error: unknown) => {
    if (error instanceof ApiClientError) {
      return null;
    }
    throw error;
  });

  return payload === null ? null : ApiProblemSchema.safeParse(payload).data ?? null;
}

async function parseSuccess<T extends z.ZodType>(response: Response, schema: T): Promise<z.output<T>> {
  const payload = await parseJson(response);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError("invalid_response", "API 返回了不符合契约的响应", response.status);
  }
  return parsed.data;
}

export function createApiClient({ apiInternalUrl, devAuthSharedSecret, fetchImpl = fetch }: ApiClientConfig) {
  async function request(path: string, init: RequestInit): Promise<Response> {
    const requestId = randomUUID();
    try {
      return await fetchImpl(apiUrl(apiInternalUrl, path), {
        ...init,
        headers: {
          ...init.headers,
          "x-request-id": requestId,
        },
      });
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("network", "无法连接 API 服务");
    }
  }

  return {
    async recordRecommendationDecision(sessionToken: string, listId: string, itemId: string, command: RecommendationDecisionCommand) {
      const response = await request(`/v1/recommendations/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/decisions`, { method: "POST", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" }, body: JSON.stringify(RecommendationDecisionCommandSchema.parse(command)) });
      if (!response.ok) { const problem = await readProblem(response); throw new ApiClientError("api", problem?.message ?? "无法记录推荐决策", response.status, problem ?? undefined); }
      return parseSuccess(response, z.object({ decision: z.object({ status: z.enum(["saved", "ignored"]), version: z.int() }).strict(), proposal: z.object({ proposalId: z.uuid() }).nullable() }).strict());
    },
    async startDeepMatchRun(sessionToken: string, targetId: string, opportunityId: string, idempotencyKey: string): Promise<{ runId: string; reused: boolean }> {
      const response = await request("/v1/recommendations/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ targetId, opportunityId, idempotencyKey }),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法开始重新评估", response.status, problem ?? undefined);
      }
      return parseSuccess(response, z.object({ runId: z.uuid(), reused: z.boolean() }).strict());
    },
    async getLatestRecommendations(sessionToken: string, targetId: string): Promise<RecommendationList> {
      const response = await request(`/v1/recommendations/latest?targetId=${encodeURIComponent(targetId)}`, { method: "GET", headers: { authorization: `Bearer ${sessionToken}` } });
      if (!response.ok) { const problem = await readProblem(response); throw new ApiClientError("api", problem?.message ?? "无法读取推荐清单", response.status, problem ?? undefined); }
      return parseSuccess(response, RecommendationListSchema);
    },
    async getRecommendationHistoryPage(sessionToken: string, targetId: string, cursor?: string): Promise<RecommendationListHistoryPage> {
      const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const response = await request(`/v1/recommendations/history?targetId=${encodeURIComponent(targetId)}&limit=20${cursorQuery}`, { method: "GET", headers: { authorization: `Bearer ${sessionToken}` } });
      if (!response.ok) { const problem = await readProblem(response); throw new ApiClientError("api", problem?.message ?? "无法读取推荐历史", response.status, problem ?? undefined); }
      return parseSuccess(response, RecommendationListHistoryPageSchema);
    },
    async getRecommendationExclusionsPage(sessionToken: string, targetId: string, recommendationListId: string, cursor?: string): Promise<RecommendationExclusionPage> {
      const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const response = await request(`/v1/recommendations/lists/${encodeURIComponent(recommendationListId)}/exclusions?targetId=${encodeURIComponent(targetId)}&limit=25${cursorQuery}`, { method: "GET", headers: { authorization: `Bearer ${sessionToken}` } });
      if (!response.ok) { const problem = await readProblem(response); throw new ApiClientError("api", problem?.message ?? "无法读取稳定排除", response.status, problem ?? undefined); }
      return parseSuccess(response, RecommendationExclusionPageSchema);
    },
    async startDevSession(input: StartDevSessionRequest): Promise<z.infer<typeof StartDevSessionResponseSchema>> {
      const requestBody = StartDevSessionRequestSchema.parse(input);
      if (!devAuthSharedSecret) {
        throw new ApiClientError("configuration", "DEV_AUTH_SHARED_SECRET 未配置");
      }
      const response = await request("/v1/auth/dev/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-auth-secret": devAuthSharedSecret,
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "Dev Auth 登录失败", response.status, problem ?? undefined);
      }
      return parseSuccess(response, StartDevSessionResponseSchema);
    },

    async endCurrentSession(sessionToken: string): Promise<"ended" | "already_invalid"> {
      const response = await request("/v1/auth/sessions/current", {
        method: "DELETE",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (response.ok) {
        return "ended";
      }

      const problem = await readProblem(response);
      if (response.status === 401 && problem?.code === "AUTH_REQUIRED") {
        return "already_invalid";
      }
      throw new ApiClientError("api", problem?.message ?? "退出失败", response.status, problem ?? undefined);
    },

    async getWorkbenchHome(sessionToken: string): Promise<WorkbenchHome> {
      const response = await request("/v1/workbench/home", {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取求职工作台", response.status, problem ?? undefined);
      }
      return parseSuccess(response, WorkbenchHomeSchema);
    },

    async getProfile(sessionToken: string): Promise<ProfileSnapshot> {
      const response = await request("/v1/profile", {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取求职画像", response.status, problem ?? undefined);
      }
      return parseSuccess(response, ProfileSnapshotSchema);
    },

    async decideCandidateFact(sessionToken: string, factId: string, command: CandidateFactDecisionCommand): Promise<ProfileSnapshot> {
      const response = await request(`/v1/profile/candidate-facts/${factId}/decisions`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法保存审核决定", response.status, problem ?? undefined);
      }
      return parseSuccess(response, ProfileSnapshotSchema);
    },

    async createProfileFact(sessionToken: string, command: CreateProfileFactCommand): Promise<ProfileSnapshot> {
      const response = await request("/v1/profile/facts", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护画像事实", response.status, problem ?? undefined);
      }
      return parseSuccess(response, ProfileSnapshotSchema);
    },

    async reviseProfileFact(sessionToken: string, factId: string, command: ReviseProfileFactCommand): Promise<ProfileSnapshot> {
      const response = await request(`/v1/profile/facts/${factId}/revisions`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护画像事实", response.status, problem ?? undefined);
      }
      return parseSuccess(response, ProfileSnapshotSchema);
    },

    async removeProfileFact(sessionToken: string, factId: string, command: RemoveProfileFactCommand): Promise<ProfileSnapshot> {
      const response = await request(`/v1/profile/facts/${factId}/removals`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护画像事实", response.status, problem ?? undefined);
      }
      return parseSuccess(response, ProfileSnapshotSchema);
    },

    async getJobTargetOverview(sessionToken: string): Promise<JobTargetOverview> {
      const response = await request("/v1/job-targets", {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取求职目标", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobTargetOverviewSchema);
    },

    async createJobTarget(sessionToken: string, command: CreateJobTargetCommand): Promise<JobTargetOverview> {
      const response = await request("/v1/job-targets", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护求职目标", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobTargetOverviewSchema);
    },

    async reviseJobTarget(sessionToken: string, targetId: string, command: ReviseJobTargetCommand): Promise<JobTargetOverview> {
      const response = await request(`/v1/job-targets/${targetId}/revisions`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护求职目标", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobTargetOverviewSchema);
    },

    async deactivateJobTarget(sessionToken: string, targetId: string, command: DeactivateJobTargetCommand): Promise<JobTargetOverview> {
      const response = await request(`/v1/job-targets/${targetId}/deactivations`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护求职目标", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobTargetOverviewSchema);
    },

    async getCompanyWatchlist(sessionToken: string, targetId: string): Promise<CompanyWatchlistOverview> {
      const response = await request(`/v1/job-targets/${targetId}/company-watchlist`, {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取目标公司 Watchlist", response.status, problem ?? undefined);
      }
      return parseSuccess(response, CompanyWatchlistOverviewSchema);
    },

    async getSourceHealth(sessionToken: string, targetId: string): Promise<JobSourceHealthOverview> {
      const response = await request(`/v1/job-targets/${targetId}/source-health`, { method: "GET", headers: { authorization: `Bearer ${sessionToken}` } });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取来源诊断", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobSourceHealthOverviewSchema);
    },

    async addCompanyWatchlistItem(sessionToken: string, targetId: string, command: AddCompanyWatchlistItemCommand): Promise<CompanyWatchlistOverview> {
      const response = await request(`/v1/job-targets/${targetId}/company-watchlist/items`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护目标公司 Watchlist", response.status, problem ?? undefined);
      }
      return parseSuccess(response, CompanyWatchlistOverviewSchema);
    },

    async reviseCompanyWatchlistItem(sessionToken: string, targetId: string, itemId: string, command: ReviseCompanyWatchlistItemCommand): Promise<CompanyWatchlistOverview> {
      const response = await request(`/v1/job-targets/${targetId}/company-watchlist/items/${itemId}/revisions`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护目标公司 Watchlist", response.status, problem ?? undefined);
      }
      return parseSuccess(response, CompanyWatchlistOverviewSchema);
    },

    async setCompanyWatchlistItemState(sessionToken: string, targetId: string, itemId: string, command: SetCompanyWatchlistItemStateCommand): Promise<CompanyWatchlistOverview> {
      const response = await request(`/v1/job-targets/${targetId}/company-watchlist/items/${itemId}/state-changes`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护目标公司 Watchlist", response.status, problem ?? undefined);
      }
      return parseSuccess(response, CompanyWatchlistOverviewSchema);
    },

    async reorderCompanyWatchlist(sessionToken: string, targetId: string, command: ReorderCompanyWatchlistCommand): Promise<CompanyWatchlistOverview> {
      const response = await request(`/v1/job-targets/${targetId}/company-watchlist/reorders`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法维护目标公司 Watchlist", response.status, problem ?? undefined);
      }
      return parseSuccess(response, CompanyWatchlistOverviewSchema);
    },

    async listCareerImports(sessionToken: string): Promise<CareerImportList> {
      const response = await request("/v1/career-documents/imports", {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取职业资料", response.status, problem ?? undefined);
      }
      return parseSuccess(response, CareerImportListSchema);
    },

    async createCareerImport(sessionToken: string, formData: FormData): Promise<CreateCareerImportResponse> {
      const response = await request("/v1/career-documents/imports", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}` },
        body: formData,
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法上传职业资料", response.status, problem ?? undefined);
      }
      return parseSuccess(response, CreateCareerImportResponseSchema);
    },

    async getCareerImport(sessionToken: string, importId: string): Promise<CareerImportDetail> {
      const response = await request(`/v1/career-documents/imports/${importId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取职业资料", response.status, problem ?? undefined);
      }
      return parseSuccess(response, CareerImportDetailSchema);
    },

    async resolveCareerFactConflict(sessionToken: string, conflictId: string, command: ResolveCareerFactConflictCommand) {
      const response = await request(`/v1/career-documents/fact-conflicts/${conflictId}/resolutions`, {
        method: "POST", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" }, body: JSON.stringify(command),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法解决职业事实冲突", response.status, problem ?? undefined);
      }
      return parseSuccess(response, ResolveCareerFactConflictResponseSchema);
    },

    async createJobImport(sessionToken: string, command: CreateJobImportCommand): Promise<CreateJobImportResponse & { reused: boolean }> {
      const requestBody = CreateJobImportCommandSchema.parse(command);
      const response = await request("/v1/job-imports", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法导入岗位", response.status, problem ?? undefined);
      }
      return { ...await parseSuccess(response, CreateJobImportResponseSchema), reused: response.status === 200 };
    },

    async listJobImports(sessionToken: string): Promise<JobImportList> {
      const response = await request("/v1/job-imports", {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取岗位导入", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobImportListSchema);
    },

    async getJobImport(sessionToken: string, importId: string): Promise<JobImportDetail> {
      const response = await request(`/v1/job-imports/${importId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取岗位导入", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobImportDetailSchema);
    },

    async getJobImportRaw(sessionToken: string, importId: string): Promise<string> {
      const response = await request(`/v1/job-imports/${importId}/raw`, {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取岗位原文", response.status, problem ?? undefined);
      }
      if (!response.headers.get("content-type")?.startsWith("text/plain")) {
        throw new ApiClientError("invalid_response", "API 返回了无效岗位原文", response.status);
      }
      return response.text();
    },

    async createJobTriageVersion(sessionToken: string, opportunityId: string, command: CreateJobTriageVersionCommand): Promise<JobTriageVersion> {
      const requestBody = CreateJobTriageVersionCommandSchema.parse(command);
      const response = await request(`/v1/job-opportunities/${opportunityId}/triage-versions`, {
        method: "POST", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" }, body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法评估岗位", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobTriageVersionSchema);
    },

    async getLatestJobTriageVersion(sessionToken: string, opportunityId: string, targetId: string): Promise<JobTriageVersion> {
      const response = await request(`/v1/job-opportunities/${opportunityId}/triage-versions/latest?targetId=${encodeURIComponent(targetId)}`, {
        method: "GET", headers: { authorization: `Bearer ${sessionToken}` }, cache: "no-store",
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取岗位评估", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobTriageVersionSchema);
    },

    async startAgentRun(sessionToken: string, command: StartAgentRunCommand): Promise<StartAgentRunResponse> {
      const requestBody = StartAgentRunCommandSchema.parse(command);
      const response = await request("/v1/agent-runs", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法启动岗位发现", response.status, problem ?? undefined);
      }
      return parseSuccess(response, StartAgentRunResponseSchema);
    },

    async getJobDiscoverySchedule(sessionToken: string, targetId: string): Promise<JobDiscoveryScheduleResponse> {
      const response = await request(`/v1/job-targets/${targetId}/discovery-schedule`, {
        method: "GET", headers: { authorization: `Bearer ${sessionToken}` }, cache: "no-store",
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取每日检查", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobDiscoveryScheduleResponseSchema);
    },

    async setJobDiscoverySchedule(sessionToken: string, targetId: string, command: SetJobDiscoveryScheduleCommand): Promise<JobDiscoveryScheduleResponse> {
      const requestBody = SetJobDiscoveryScheduleCommandSchema.parse(command);
      const response = await request(`/v1/job-targets/${targetId}/discovery-schedule`, {
        method: "PUT", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" }, body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法保存每日检查", response.status, problem ?? undefined);
      }
      return parseSuccess(response, JobDiscoveryScheduleResponseSchema);
    },

    async getLatestAgentRun(sessionToken: string) {
      const response = await request("/v1/agent-runs/latest", {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取最近 Agent 运行", response.status, problem ?? undefined);
      }
      return parseSuccess(response, LatestAgentRunResponseSchema);
    },

    async getAgentRun(sessionToken: string, runId: string): Promise<AgentRunDetail> {
      const response = await request(`/v1/agent-runs/${runId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取 Agent 运行", response.status, problem ?? undefined);
      }
      return parseSuccess(response, AgentRunDetailSchema);
    },

    async controlAgentRun(sessionToken: string, runId: string, command: ControlAgentRunCommand): Promise<ControlAgentRunResponse> {
      const requestBody = ControlAgentRunCommandSchema.parse(command);
      const response = await request(`/v1/agent-runs/${runId}/controls`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法控制 Agent 运行", response.status, problem ?? undefined);
      }
      return parseSuccess(response, ControlAgentRunResponseSchema);
    },

    async listAgentInbox(sessionToken: string, status: z.infer<typeof AgentInboxStatusSchema>): Promise<z.infer<typeof AgentInboxListSchema>> {
      const query = new URLSearchParams({ status: AgentInboxStatusSchema.parse(status) });
      const response = await request(`/v1/agent-inbox?${query.toString()}`, {
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取 Agent Inbox", response.status, problem ?? undefined);
      }
      return parseSuccess(response, AgentInboxListSchema);
    },

    async actOnAgentInboxItem(sessionToken: string, itemId: string, command: AgentInboxActionCommand): Promise<AgentInboxActionResponse> {
      const requestBody = AgentInboxActionCommandSchema.parse(command);
      const response = await request(`/v1/agent-inbox/${itemId}/actions`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法处理 Agent Inbox", response.status, problem ?? undefined);
      }
      return parseSuccess(response, AgentInboxActionResponseSchema);
    },

    async openAgentRunEventStream(
      sessionToken: string,
      runId: string,
      options: { lastEventId?: string; afterEventId?: string; signal?: AbortSignal },
    ): Promise<Response> {
      const query = new URLSearchParams();
      if (options.afterEventId !== undefined) query.set("afterEventId", AgentRunSseCursorSchema.parse(options.afterEventId));
      const path = `/v1/agent-runs/${runId}/events${query.size > 0 ? `?${query.toString()}` : ""}`;
      const headers: Record<string, string> = { authorization: `Bearer ${sessionToken}` };
      if (options.lastEventId !== undefined) headers["last-event-id"] = AgentRunSseCursorSchema.parse(options.lastEventId);
      const response = await request(path, { method: "GET", headers, signal: options.signal });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new ApiClientError("api", problem?.message ?? "无法读取 Agent 运行进度", response.status, problem ?? undefined);
      }
      if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new ApiClientError("invalid_response", "API 返回了无效 Agent 运行事件流", response.status);
      }
      return response;
    },
  };
}

export const api = createApiClient({
  apiInternalUrl: process.env.API_INTERNAL_URL ?? "",
  devAuthSharedSecret: process.env.DEV_AUTH_SHARED_SECRET ?? "",
});

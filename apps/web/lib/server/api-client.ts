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
} from "@job-copilot/contracts/career-import";
import { WorkbenchHomeSchema, type WorkbenchHome } from "@job-copilot/contracts/workbench";
import { z } from "zod";

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
  };
}

export const api = createApiClient({
  apiInternalUrl: process.env.API_INTERNAL_URL ?? "",
  devAuthSharedSecret: process.env.DEV_AUTH_SHARED_SECRET ?? "",
});

import { expect, it } from "vitest";
import { AccountRunAdmissionError } from "@job-copilot/domain/account-run-control";
import { RecommendationRunsController } from "./recommendation-runs.controller.js";

const owner = "00000000-0000-4000-8000-000000000001";
const request = { authenticatedAccount: { userId: owner }, requestId: "00000000-0000-4000-8000-000000000002" } as never;

it("推荐运行仅从会话身份读取 owner，并将账户停止映射为安全 409", async () => {
  const controller = new RecommendationRunsController({ start: async (input: unknown) => { expect(input).toMatchObject({ userId: owner }); throw new AccountRunAdmissionError("ACCOUNT_RUN_STOPPED"); } } as never, {} as never, {} as never);
  await expect(controller.start(request, { idempotencyKey: "00000000-0000-4000-8000-000000000003", warningFingerprint: null } as never))
    .rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED", status: 409, publicMessage: "账户已停止全部运行，请先解除全局停止" });
});

it("owner 不匹配的逻辑 root 读取保持隐藏 404", async () => {
  const controller = new RecommendationRunsController({} as never, { get: async () => null } as never, {} as never);
  await expect(controller.get(request, { runId: "00000000-0000-4000-8000-000000000003" } as never)).rejects.toMatchObject({ code: "RECOMMENDATION_RUN_NOT_FOUND", status: 404 });
});

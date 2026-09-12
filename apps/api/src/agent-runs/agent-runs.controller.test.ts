import { expect, it } from "vitest";
import { AgentRunError } from "@job-copilot/domain/agent-runs";
import { AgentRunsController } from "./agent-runs.controller.js";

it("账户停止时启动旧发现入口返回安全 409", async () => {
  const controller = new AgentRunsController({ start: async () => { throw new AgentRunError("ACCOUNT_RUN_STOPPED"); } } as never, {} as never);

  await expect(controller.start(
    { authenticatedAccount: { userId: "00000000-0000-4000-8000-000000000001" }, requestId: "00000000-0000-4000-8000-000000000002" } as never,
    { status() {} } as never,
    { targetId: "00000000-0000-4000-8000-000000000003", idempotencyKey: "00000000-0000-4000-8000-000000000004" } as never,
  )).rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED", status: 409, publicMessage: "账户已停止全部运行，请先解除全局停止" });
});

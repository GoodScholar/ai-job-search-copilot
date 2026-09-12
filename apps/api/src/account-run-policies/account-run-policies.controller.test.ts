import { expect, it } from "vitest";
import { AccountRunControlError } from "@job-copilot/domain/account-run-control";
import { AccountRunPoliciesController } from "./account-run-policies.controller.js";

const userId = "00000000-0000-4000-8000-000000000001";
const command = { commandId: "00000000-0000-4000-8000-000000000002", expectedVersion: 0, action: "stop" } as const;

it("控制器只把会话账户和请求 ID 传给账户全局控制，并统一返回命令结果", async () => {
  const calls: unknown[] = [];
  const controller = new AccountRunPoliciesController({} as never, {
    get: async (input: unknown) => { calls.push(input); return { stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null }; },
    control: async (input: unknown) => { calls.push(input); return { applied: true, state: { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null } }; },
  } as never);

  await expect(controller.control(
    { authenticatedAccount: { userId }, requestId: "00000000-0000-4000-8000-000000000003" } as never,
    command,
  )).resolves.toEqual({ applied: true, state: { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null } });
  expect(calls).toEqual([{ userId, requestId: "00000000-0000-4000-8000-000000000003", command }]);
});

it("控制冲突映射为安全 409", async () => {
  const controller = new AccountRunPoliciesController({} as never, {
    get: async () => ({ stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null }),
    control: async () => { throw new AccountRunControlError("ACCOUNT_RUN_CONTROL_VERSION_CONFLICT"); },
  } as never);

  await expect(controller.control({ authenticatedAccount: { userId }, headers: {} } as never, command))
    .rejects.toMatchObject({ code: "ACCOUNT_RUN_CONTROL_VERSION_CONFLICT", status: 409, publicMessage: "账户运行控制已变化，请刷新后重试" });
});

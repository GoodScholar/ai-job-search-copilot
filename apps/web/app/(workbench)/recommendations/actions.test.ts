import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ApiClientError extends Error {
    constructor(readonly problem?: { code?: string }) { super("api"); }
  }
  return { ApiClientError, revalidatePath: vi.fn(), resolveCalibrationProposal: vi.fn(), readSessionToken: vi.fn() };
});
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { resolveCalibrationProposal: mocks.resolveCalibrationProposal }, ApiClientError: mocks.ApiClientError }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { resolveCalibrationProposalAction } from "./actions";

it("规则版本 409 返回结构化冲突结果且仍失效 recommendations 读模型", async () => {
  mocks.readSessionToken.mockResolvedValue("session");
  mocks.resolveCalibrationProposal.mockRejectedValue(new mocks.ApiClientError({ code: "RULE_VERSION_CONFLICT" }));
  const formData = new FormData(); formData.set("action", "approved"); formData.set("expectedVersion", "1"); formData.set("idempotencyKey", "00000000-0000-4000-8000-000000000001");

  await expect(resolveCalibrationProposalAction("00000000-0000-4000-8000-000000000002", formData)).resolves.toEqual({ kind: "rule_version_conflict" });
  expect(mocks.revalidatePath).toHaveBeenCalledWith("/recommendations");
});

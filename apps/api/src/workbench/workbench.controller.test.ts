import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { FirstRecommendationJourneyError } from "@job-copilot/domain/first-recommendation-journey";
import { WorkbenchController } from "./workbench.controller.js";

const userId = "00000000-0000-4000-8000-000000000001";
const visitCommand = { action: "visit_step" as const, stepId: "career_materials" as const, expectedVersion: 0 };
const dismissCommand = { action: "dismiss" as const, expectedVersion: 1 };

function reply() {
  return { headers: [] as string[], header(name: string, value: string) { this.headers.push(`${name}:${value}`); } };
}

describe("工作台首次推荐旅程控制器", () => {
  it("只使用认证账户读取首页并禁用缓存", async () => {
    const calls: unknown[] = [];
    const controller = new WorkbenchController(async (input) => { calls.push(input); return {} as never; }, { updateInteraction: async () => ({ version: 0, dismissedAt: null, lastVisitedStep: null }) });
    const response = reply();

    await expect(controller.getHome({ authenticatedAccount: { userId } } as never, response as never)).resolves.toEqual({});
    expect(calls).toEqual([{ userId }]);
    expect(response.headers).toEqual(["Cache-Control:no-store"]);
  });

  it("只转发认证账户和严格访问或关闭命令", async () => {
    const calls: unknown[] = [];
    const controller = new WorkbenchController(async () => ({} as never), {
      updateInteraction: async (input) => {
        calls.push(input);
        return input.command.action === "dismiss"
          ? { version: 2, dismissedAt: "2026-09-06T00:00:00.000Z", lastVisitedStep: "career_materials" }
          : { version: 1, dismissedAt: null, lastVisitedStep: "career_materials" };
      },
    });
    const request = { authenticatedAccount: { userId } } as never;
    const visitReply = reply();
    const dismissReply = reply();

    await expect(controller.updateJourney(request, visitReply as never, visitCommand)).resolves.toEqual({ version: 1, dismissedAt: null, lastVisitedStep: "career_materials" });
    await expect(controller.updateJourney(request, dismissReply as never, dismissCommand)).resolves.toEqual({ version: 2, dismissedAt: "2026-09-06T00:00:00.000Z", lastVisitedStep: "career_materials" });
    expect(calls).toEqual([{ userId, command: visitCommand }, { userId, command: dismissCommand }]);
    expect([visitReply.headers, dismissReply.headers]).toEqual([["Cache-Control:no-store"], ["Cache-Control:no-store"]]);
  });

  it.each([
    [{ ...visitCommand, userId }, "客户端不能注入 owner"],
    [{ ...visitCommand, unexpected: "value" }, "未知字段必须拒绝"],
  ])("拒绝不严格的旅程交互命令：%s", async (body, _reason) => {
    const controller = new WorkbenchController(async () => ({} as never), { updateInteraction: async () => ({ version: 0, dismissedAt: null, lastVisitedStep: null }) });

    await expect(controller.updateJourney({ authenticatedAccount: { userId } } as never, reply() as never, body)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it.each([
    ["账户不存在", "ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND],
    ["交互版本陈旧", "VERSION_CONFLICT", HttpStatus.CONFLICT],
    ["旅程已经完成", "JOURNEY_COMPLETED", HttpStatus.CONFLICT],
  ] as const)("将%s稳定映射为公开问题", async (_name, code, status) => {
    const controller = new WorkbenchController(async () => ({} as never), {
      updateInteraction: async () => { throw new FirstRecommendationJourneyError(code); },
    });

    await expect(controller.updateJourney({ authenticatedAccount: { userId } } as never, reply() as never, visitCommand)).rejects.toMatchObject({ code, status });
  });
});

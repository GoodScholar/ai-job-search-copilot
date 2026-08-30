import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createProcessRunner, executeE2E, normalizeE2EArguments, selectE2EPhases } from "./e2e-runner.mjs";

type RunnerCall = { phase: string; args: string[]; environment: Record<string, string | undefined> };

const baseEnvironment = { CI: "true", KEEP_ME: "yes" } as unknown as NodeJS.ProcessEnv;

describe("E2E runner", () => {
  it("无参数按 ordinary、source-health 顺序运行", async () => {
    const calls: RunnerCall[] = [];
    const result = await executeE2E([], {
      environment: baseEnvironment,
      run: async (call: RunnerCall) => { calls.push(call); return { code: 0, stdout: "" }; },
    });

    expect(result).toEqual({ code: 0 });
    expect(calls).toEqual([
      { phase: "ordinary", args: [], environment: { CI: "true", KEEP_ME: "yes" } },
      { phase: "source-health", args: [], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
    ]);
  });

  it("明确普通或 source-health spec 时只运行对应阶段并原样透传参数", async () => {
    expect(await selectE2EPhases(["e2e/auth-workbench.spec.ts", "--list"])).toEqual(["ordinary"]);
    expect(await selectE2EPhases(["e2e/source-health.spec.ts", "--project", "Mobile Safari"])).toEqual(["source-health"]);
  });

  it("只剥离 pnpm 附加的一个 leading --，让普通与 source-health 聚焦参数仍是 Playwright 选项", async () => {
    expect(normalizeE2EArguments(["--", "e2e/auth-workbench.spec.ts", "--list"])).toEqual(["e2e/auth-workbench.spec.ts", "--list"]);
    expect(normalizeE2EArguments(["--", "e2e/source-health.spec.ts", "--project", "Mobile Safari"])).toEqual(["e2e/source-health.spec.ts", "--project", "Mobile Safari"]);
    expect(normalizeE2EArguments(["--", "--project", "Desktop Chrome", "--grep", "来源", "--", "literal"])).toEqual(["--project", "Desktop Chrome", "--grep", "来源", "--", "literal"]);

    const ordinaryCalls: Array<{ phase: string; args: string[] }> = [];
    await executeE2E(normalizeE2EArguments(["--", "e2e/auth-workbench.spec.ts", "--list"]), {
      environment: baseEnvironment,
      run: async (call: RunnerCall) => { ordinaryCalls.push(call); return { code: 0, stdout: "" }; },
    });
    expect(ordinaryCalls).toEqual([{ phase: "ordinary", args: ["e2e/auth-workbench.spec.ts", "--list"], environment: { CI: "true", KEEP_ME: "yes" } }]);

    const sourceCalls: Array<{ phase: string; args: string[] }> = [];
    await executeE2E(normalizeE2EArguments(["--", "e2e/source-health.spec.ts", "--list"]), {
      environment: baseEnvironment,
      run: async (call: RunnerCall) => { sourceCalls.push(call); return { code: 0, stdout: "" }; },
    });
    expect(sourceCalls).toEqual([{ phase: "source-health", args: ["e2e/source-health.spec.ts", "--list"], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } }]);

    const genericCalls: RunnerCall[] = [];
    await executeE2E(normalizeE2EArguments(["--", "--project", "Desktop Chrome", "--grep", "来源"]), {
      environment: { ...baseEnvironment, E2E_SOURCE_HEALTH_ONLY: "1" },
      run: async (call: RunnerCall) => {
        genericCalls.push(call);
        return { code: call.args[0] === "--list" && call.phase === "ordinary" ? 1 : 0, stdout: call.args[0] === "--list" && call.phase === "ordinary" ? "No tests found" : "Total: 1 test" };
      },
    });
    expect(genericCalls).toEqual([
      { phase: "ordinary", args: ["--list", "--project", "Desktop Chrome", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes" } },
      { phase: "source-health", args: ["--list", "--project", "Desktop Chrome", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
      { phase: "source-health", args: ["--project", "Desktop Chrome", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
    ]);
  });

  it("--project 和 --grep 通过预检只运行有匹配的阶段，并保留 CI 与过滤参数", async () => {
    const calls: RunnerCall[] = [];
    const run = async (call: RunnerCall) => {
      calls.push(call);
      if (call.args[0] === "--list") {
        return { code: call.phase === "source-health" ? 0 : 1, stdout: call.phase === "source-health" ? "Total: 1 test" : "No tests found" };
      }
      return { code: 0, stdout: "" };
    };

    await expect(executeE2E(["--project", "Mobile Safari", "--grep", "来源"], { environment: baseEnvironment, run })).resolves.toEqual({ code: 0 });
    expect(calls).toEqual([
      { phase: "ordinary", args: ["--list", "--project", "Mobile Safari", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes" } },
      { phase: "source-health", args: ["--list", "--project", "Mobile Safari", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
      { phase: "source-health", args: ["--project", "Mobile Safari", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
    ]);
  });

  it("两个阶段都匹配时按顺序运行，且首阶段失败、专用阶段失败或信号都会停止后续阶段", async () => {
    const both = async (call: RunnerCall) => ({ code: 0, stdout: call.args[0] === "--list" ? "Total: 1 test" : "" });
    await expect(executeE2E(["--grep", ".*"], { environment: baseEnvironment, run: both })).resolves.toEqual({ code: 0 });

    const firstFailure: string[] = [];
    await expect(executeE2E([], { environment: baseEnvironment, run: async (call: RunnerCall) => { firstFailure.push(call.phase); return { code: 7, stdout: "" }; } })).resolves.toEqual({ code: 7 });
    expect(firstFailure).toEqual(["ordinary"]);

    const secondFailure: string[] = [];
    await expect(executeE2E([], { environment: baseEnvironment, run: async (call: RunnerCall) => { secondFailure.push(call.phase); return { code: call.phase === "source-health" ? 9 : 0, stdout: "" }; } })).resolves.toEqual({ code: 9 });
    expect(secondFailure).toEqual(["ordinary", "source-health"]);

    const interrupted: string[] = [];
    await expect(executeE2E([], { environment: baseEnvironment, run: async (call: RunnerCall) => { interrupted.push(call.phase); return { code: null, signal: "SIGTERM", stdout: "" }; } })).resolves.toEqual({ signal: "SIGTERM" });
    expect(interrupted).toEqual(["ordinary"]);
  });

  it("向活跃 Playwright 子进程转发信号、等待 close 并在 dispose 后移除监听器", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    const listeners = new Map<string, (signal: NodeJS.Signals) => void>();
    const processRef = {
      platform: "linux",
      execPath: process.execPath,
      cwd: () => process.cwd(),
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      on: vi.fn((signal: string, listener: (signal: NodeJS.Signals) => void) => { listeners.set(signal, listener); }),
      off: vi.fn((signal: string) => { listeners.delete(signal); }),
    };
    const runner = createProcessRunner({ processRef: processRef as never, spawnProcess: vi.fn(() => child) as never });
    let settled = false;
    const pending = runner.run({ args: ["--list"], environment: baseEnvironment }).then((result) => { settled = true; return result; });
    listeners.get("SIGTERM")!("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toEqual({ code: null, signal: "SIGTERM", stdout: "" });
    runner.dispose();
    expect(listeners.size).toBe(0);
  });
});

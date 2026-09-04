import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createProcessRunner, executeE2E, normalizeE2EArguments, selectE2EPhases } from "./e2e-runner.mjs";

type RunnerCall = { phase: string; args: string[]; environment: Record<string, string | undefined> };

const baseEnvironment = { CI: "true", KEEP_ME: "yes" } as unknown as NodeJS.ProcessEnv;

describe("E2E runner", () => {
  it("无参数按 ordinary、source-health、workbench-inbox 顺序运行", async () => {
    const calls: RunnerCall[] = [];
    const result = await executeE2E([], {
      environment: baseEnvironment,
      run: async (call: RunnerCall) => { calls.push(call); return { code: 0, stdout: "" }; },
    });

    expect(result).toEqual({ code: 0 });
    expect(calls).toEqual([
      { phase: "ordinary", args: [], environment: { CI: "true", KEEP_ME: "yes" } },
      { phase: "source-health", args: [], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
      { phase: "workbench-inbox", args: [], environment: { CI: "true", KEEP_ME: "yes", E2E_WORKBENCH_INBOX_SOURCE_ONLY: "1" } },
    ]);
  });

  it("ordinary 与 source-health 都清理遗留的 AnySearch phase、base、origin 和 scenario 污染", async () => {
    const calls: RunnerCall[] = [];
    await executeE2E([], {
      environment: {
        ...baseEnvironment,
        E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1",
        ANYSEARCH_BASE_URL: "http://stale.invalid",
        ANYSEARCH_PROVIDER_BASE_URL: "http://stale.invalid",
        JOB_PAGE_FETCHER_TEST_ORIGIN: "http://stale.invalid",
        E2E_AGENT_RUN_SCENARIOS: '{"stale":"retry_once"}',
        E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"stale":{}}',
      },
      run: async (call: RunnerCall) => { calls.push(call); return { code: 0, stdout: "" }; },
    });
    expect(calls).toEqual([
      { phase: "ordinary", args: [], environment: { CI: "true", KEEP_ME: "yes" } },
      { phase: "source-health", args: [], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
      { phase: "workbench-inbox", args: [], environment: { CI: "true", KEEP_ME: "yes", E2E_WORKBENCH_INBOX_SOURCE_ONLY: "1" } },
    ]);
  });

  it("明确普通、source-health 或 workbench-inbox spec 时只运行对应阶段并原样透传参数", async () => {
    expect(await selectE2EPhases(["e2e/auth-workbench.spec.ts", "--list"])).toEqual(["ordinary"]);
    expect(await selectE2EPhases(["e2e/source-health.spec.ts", "--project", "Mobile Safari"])).toEqual(["source-health"]);
    expect(await selectE2EPhases(["e2e/workbench-inbox.spec.ts", "--project", "Mobile Safari"])).toEqual(["ordinary", "workbench-inbox"]);
  });

  it("版本化 Fake AnySearch spec 依次进入 configured 与 missing-key phase，并清理其他 phase 与 transport 注入", async () => {
    const arguments_ = ["e2e/anysearch-public-job-discovery.spec.ts", "--project", "Desktop Chrome"];
    expect(await selectE2EPhases(arguments_)).toEqual(["anysearch-configured", "anysearch-missing-key"]);

    const calls: RunnerCall[] = [];
    await expect(executeE2E(arguments_, {
      environment: {
        ...baseEnvironment,
        ANYSEARCH_BASE_URL: "http://untrusted.example",
        ANYSEARCH_PROVIDER_BASE_URL: "http://untrusted.example",
        E2E_AGENT_RUN_SCENARIOS: '{"stale":"retry_once"}',
        E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "stale",
        E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"stale":{}}',
        E2E_SOURCE_HEALTH_ONLY: "1",
        JOB_PAGE_FETCHER_TEST_ORIGIN: "http://untrusted.example",
      },
      run: async (call: RunnerCall) => { calls.push(call); return { code: 0, stdout: "" }; },
    })).resolves.toEqual({ code: 0 });

    expect(calls).toEqual([
      {
        phase: "anysearch-configured",
        args: arguments_,
        environment: {
          CI: "true",
          KEEP_ME: "yes",
          E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-v1",
        },
      },
      {
        phase: "anysearch-missing-key",
        args: arguments_,
        environment: {
          CI: "true",
          KEEP_ME: "yes",
          E2E_ANYSEARCH_PUBLIC_JOB_PHASE: "fake-anysearch-public-job-missing-key-v1",
        },
      },
    ]);
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
      { phase: "workbench-inbox", args: ["--list", "--project", "Desktop Chrome", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_WORKBENCH_INBOX_SOURCE_ONLY: "1" } },
      { phase: "source-health", args: ["--project", "Desktop Chrome", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
      { phase: "workbench-inbox", args: ["--project", "Desktop Chrome", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_WORKBENCH_INBOX_SOURCE_ONLY: "1" } },
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
      { phase: "workbench-inbox", args: ["--list", "--project", "Mobile Safari", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_WORKBENCH_INBOX_SOURCE_ONLY: "1" } },
      { phase: "source-health", args: ["--project", "Mobile Safari", "--grep", "来源"], environment: { CI: "true", KEEP_ME: "yes", E2E_SOURCE_HEALTH_ONLY: "1" } },
    ]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("通用预检收到 %s 时原样传播且不启动后续阶段", async (signal) => {
    const calls: RunnerCall[] = [];
    const result = await executeE2E(["--grep", "x"], {
      environment: baseEnvironment,
      run: async (call: RunnerCall) => {
        calls.push(call);
        return { code: null, signal, stdout: "" };
      },
    });

    expect(result).toEqual({ signal });
    expect(calls).toEqual([
      { phase: "ordinary", args: ["--list", "--grep", "x"], environment: { CI: "true", KEEP_ME: "yes" } },
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

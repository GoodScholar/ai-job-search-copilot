import { describe, expect, it, vi } from "vitest";

const createRunPreflightEvaluator = vi.hoisted(() => vi.fn(() => ({ evaluate: vi.fn() })));

vi.mock("@job-copilot/domain/run-preflight", () => ({ createRunPreflightEvaluator }));

import { createWorkerRunPreflight } from "./run-preflight.js";

describe("createWorkerRunPreflight", () => {
  it("将当前岗位规范化元数据交给运行前检查", () => {
    createWorkerRunPreflight({ environment: { APP_ENV: "test" }, executionMode: "fake" });

    expect(createRunPreflightEvaluator).toHaveBeenCalledWith(expect.objectContaining({
      jobNormalizerMetadata: expect.objectContaining({ adapter: "fake", normalizerVersion: "fake-job-normalizer-v2", model: null }),
    }));
  });
});

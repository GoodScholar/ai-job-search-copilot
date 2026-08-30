import { z } from "zod";
import type { JobDiscoveryAdapter, JobDiscoveryAdapterResolver } from "@job-copilot/domain/agent-runs";
import {
  AgentRunExecutionSpecSchema,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
} from "@job-copilot/contracts/agent-runs";

import { FakeJobDiscoveryAdapter } from "./fake-job-discovery-adapter.js";
import { GreenhouseJobDiscoveryAdapter } from "./greenhouse-job-discovery-adapter.js";

const FAKE_ADAPTER = "fake";
const FAKE_ADAPTER_VERSION = "fake-job-discovery-v1";
const SLOW_CHECKPOINT_DELAY_MS = 750;

const FakeScenarioMapSchema = z.record(
  z.uuid(),
  z.enum(["slow_checkpoint", "retry_once", "retry_until_budget"]),
);

type FakeScenario = z.infer<typeof FakeScenarioMapSchema>;

function scenariosFrom(environment: NodeJS.ProcessEnv): FakeScenario {
  const configured = environment.E2E_AGENT_RUN_SCENARIOS;
  if (environment.APP_ENV !== "test") {
    if (configured?.trim()) throw new Error("E2E Agent Run 场景只允许测试环境");
    return {};
  }
  if (!configured?.trim()) return {};
  try {
    return FakeScenarioMapSchema.parse(JSON.parse(configured));
  } catch {
    throw new Error("E2E_AGENT_RUN_SCENARIOS 格式无效");
  }
}

function fakeForScenario(scenario: FakeScenario[string] | undefined, attemptCount: number): JobDiscoveryAdapter {
  if (scenario === "slow_checkpoint") return new FakeJobDiscoveryAdapter({ delayMs: SLOW_CHECKPOINT_DELAY_MS });
  if (scenario === "retry_once" && attemptCount === 1) {
    return new FakeJobDiscoveryAdapter({ failures: { searchBatch: { code: "FAKE_SCENARIO_RETRY_ONCE", retryable: true } } });
  }
  if (scenario === "retry_until_budget") {
    return new FakeJobDiscoveryAdapter({ failures: { searchBatch: { code: "FAKE_SCENARIO_RETRY_UNTIL_BUDGET", retryable: true } } });
  }
  return new FakeJobDiscoveryAdapter();
}

/** 仅根据持久化 run metadata 选择 Worker 的岗位发现 adapter。 */
export function createJobDiscoveryAdapterResolver(environment: NodeJS.ProcessEnv = process.env): JobDiscoveryAdapterResolver {
  const scenarios = scenariosFrom(environment);
  if (environment.APP_ENV !== "local" && environment.APP_ENV !== "test" && environment.APP_ENV !== "production") {
    throw new Error("JobDiscoveryAdapter 环境未获允许");
  }
  return {
    resolve(input) {
      const executionSpec = AgentRunExecutionSpecSchema.safeParse(input.executionSpec);
      if (!executionSpec.success) throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
      if (executionSpec.data.adapter === FAKE_ADAPTER && executionSpec.data.adapterVersion === FAKE_ADAPTER_VERSION) {
        return fakeForScenario(scenarios[input.idempotencyKey], input.attemptCount);
      }
      if (executionSpec.data.adapter === GREENHOUSE_JOB_DISCOVERY_ADAPTER && executionSpec.data.adapterVersion === GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION) {
        if (environment.APP_ENV === "test" || environment.APP_ENV === undefined || environment.APP_ENV === "local" && environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== "greenhouse") {
          throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
        }
        return new GreenhouseJobDiscoveryAdapter();
      }
      throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
    },
  };
}

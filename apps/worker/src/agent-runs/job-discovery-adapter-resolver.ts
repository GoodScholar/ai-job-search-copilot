import type { JobDiscoveryAdapter, JobDiscoveryAdapterResolver, LayeredPublicJobDiscoveryWorkflow, LayeredPublicJobDiscoveryWorkflowResolver, SourceHealthDiscoveryAdapterResolver } from "@job-copilot/domain/agent-runs";
import {
  AgentRunExecutionSpecSchema,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER,
  GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
  GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
  GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION,
} from "@job-copilot/contracts/agent-runs";
import { resolveJobDiscoveryRuntimeConfig, type AgentRunScenarioMap } from "@job-copilot/domain/job-discovery-execution-mode";

import { FakeJobDiscoveryAdapter } from "./fake-job-discovery-adapter.js";
import { FakePublicSourceHealthAdapter, type FakePublicSourceHealthScenario } from "./fake-public-source-health-adapter.js";
import { GreenhouseJobDiscoveryAdapter } from "./greenhouse-job-discovery-adapter.js";
import { GreenhouseSourceHealthAdapter } from "./greenhouse-source-health-adapter.js";

const FAKE_ADAPTER = "fake";
const FAKE_ADAPTER_VERSION = "fake-job-discovery-v1";
const SLOW_CHECKPOINT_DELAY_MS = 750;

function fakeForScenario(scenario: AgentRunScenarioMap[string] | undefined, attemptCount: number): JobDiscoveryAdapter {
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
  const config = resolveJobDiscoveryRuntimeConfig(environment);
  return {
    resolve(input) {
      const executionSpec = AgentRunExecutionSpecSchema.safeParse(input.executionSpec);
      if (!executionSpec.success) throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
      if (executionSpec.data.adapter === FAKE_ADAPTER && executionSpec.data.adapterVersion === FAKE_ADAPTER_VERSION) {
        return fakeForScenario(config.agentRunScenarios[input.idempotencyKey], input.attemptCount);
      }
      if (executionSpec.data.adapter === GREENHOUSE_JOB_DISCOVERY_ADAPTER && executionSpec.data.adapterVersion === GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION) {
        if (config.environment === "test" || config.environment === "local" && config.executionMode !== "greenhouse") {
          throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
        }
        return new GreenhouseJobDiscoveryAdapter();
      }
      throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
    },
  };
}

/** v3 受控来源检查与旧批量 adapter 解析分离，避免改变冻结 v1/v2 恢复路径。 */
export function createSourceHealthDiscoveryAdapterResolver(environment: NodeJS.ProcessEnv = process.env): SourceHealthDiscoveryAdapterResolver {
  const config = resolveJobDiscoveryRuntimeConfig(environment);
  return {
    resolve(input) {
      const executionSpec = AgentRunExecutionSpecSchema.safeParse(input.executionSpec);
      if (!executionSpec.success
        || executionSpec.data.workflowVersion !== GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION
        || executionSpec.data.adapter !== GREENHOUSE_JOB_DISCOVERY_ADAPTER
        || executionSpec.data.adapterVersion !== GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION) {
        throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
      }
      if (config.environment === "test") return new FakePublicSourceHealthAdapter(config.sourceHealthScenarios[input.idempotencyKey] as Readonly<Record<string, FakePublicSourceHealthScenario>> | undefined);
      if (config.environment === "production" || config.executionMode === "greenhouse") {
        return new GreenhouseSourceHealthAdapter();
      }
      throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
    },
  };
}

/** v4 仅接受已冻结的分层公开发现规格；生产组装由 Module 注入 provider ports。 */
export function createLayeredPublicJobDiscoveryWorkflowResolver(input: {
  createWorkflow(): LayeredPublicJobDiscoveryWorkflow;
}): LayeredPublicJobDiscoveryWorkflowResolver {
  return {
    resolve({ executionSpec }) {
      const parsed = AgentRunExecutionSpecSchema.safeParse(executionSpec);
      if (!parsed.success || parsed.data.workflowVersion !== "layered-public-job-discovery-v1") throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
      return input.createWorkflow();
    },
  };
}

import type { AgentRunStartErrorCode } from "@job-copilot/contracts/agent-runs";

export class AgentRunError extends Error {
  constructor(public readonly code: AgentRunStartErrorCode) { super(code); }
}

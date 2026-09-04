import type { createAgentInbox } from "@job-copilot/domain/agent-runs";

export const AGENT_INBOX = Symbol("AGENT_INBOX");

export type AgentInbox = ReturnType<typeof createAgentInbox>;

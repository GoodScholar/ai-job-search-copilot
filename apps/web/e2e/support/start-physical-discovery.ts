import { expect, type APIRequestContext } from "@playwright/test";
import { StartAgentRunResponseSchema, type StartAgentRunCommand, type StartAgentRunResponse } from "@job-copilot/contracts/agent-runs";

/** Shared compatibility contract only: each caller keeps its own preparation and navigation assertions. */
export async function startPhysicalDiscovery(request: APIRequestContext, command: StartAgentRunCommand): Promise<StartAgentRunResponse> {
  const createdResponse = await request.post("/api/agent-runs", { data: command });
  expect(createdResponse.status()).toBe(201);
  const created = StartAgentRunResponseSchema.parse(await createdResponse.json());
  expect(created).toMatchObject({ targetId: command.targetId, reused: false });
  const replayResponse = await request.post("/api/agent-runs", { data: command });
  expect(replayResponse.status()).toBe(200);
  await expect(replayResponse.json()).resolves.toMatchObject({ runId: created.runId, targetId: command.targetId, reused: true });
  return created;
}

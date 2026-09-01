import type { SelectedDeepMatchCandidate } from "./deep-match-persistence";

type Queries = { selectCandidates(input: { userId: string; targetId: string }): Promise<SelectedDeepMatchCandidate[]> };
type Commands = {
  createMatch(input: { userId: string; targetId: string; candidate: SelectedDeepMatchCandidate }): Promise<{ matchVersionId: string }>;
  createDailyList(input: { userId: string; targetId: string; matchVersionIds: readonly string[] }): Promise<{ items: Array<{ matchVersionId: string; highlighted: boolean; ordinal: number }> }>;
};

/** 供现有 durable Agent Run processor 调用的受限深度匹配步骤；不做外部 I/O。 */
export async function runDeepMatchWorkflow(input: { userId: string; targetId: string; queries: Queries; commands: Commands }) {
  const candidates = (await input.queries.selectCandidates({ userId: input.userId, targetId: input.targetId })).slice(0, 10);
  const matchVersionIds: string[] = [];
  for (const candidate of candidates) {
    const created = await input.commands.createMatch({ userId: input.userId, targetId: input.targetId, candidate });
    matchVersionIds.push(created.matchVersionId);
  }
  return input.commands.createDailyList({ userId: input.userId, targetId: input.targetId, matchVersionIds });
}

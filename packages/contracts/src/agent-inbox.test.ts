import { describe, expect, it } from "vitest";
import { AgentInboxActionCommandSchema, AgentInboxItemSchema, AgentInboxListSchema } from "./agent-inbox";

const itemId = "9d482ff6-a614-4ed0-bc14-97ce888c1559";
const runId = "1e764df5-19f3-49f3-b16e-512147298baa";
const candidateFactId = "e9f7f71b-bffd-42da-a201-6cc982be0069";
const watchlistItemId = "6f33fc64-1a9f-4d02-b18e-8cf403d98d20";
const recommendationListId = "95410c35-aa1b-4d27-8bb0-bb2685779d0f";
const proposalId = "a2a08b93-a89d-4d21-85f1-7bf73fe26e07";
const targetId = "1b2f8ef3-04d8-44a6-b30a-ac5d545be3e7";
const actionId = "d1e8d370-16c8-44c2-bad5-483a8c0f0f0f";
const createdAt = "2026-09-04T00:00:00.000Z";
const readAt = "2026-09-04T00:01:00.000Z";
const resolvedAt = "2026-09-04T00:02:00.000Z";
const copy = { title: "待处理事项", message: "请查看并处理此事项。", basis: "系统记录到需要用户确认的状态。", impact: "后续工作会等待该事项处理。", suggestedAction: "查看详情" };

describe("agent inbox contracts", () => {
  it("parses an unread candidate-fact item with its allowlisted target", () => {
    expect(AgentInboxItemSchema.parse({ itemId, runId: null, kind: "candidate_fact", status: "unread", reasonCode: "CANDIDATE_FACT_PENDING", budgetDimension: null, ...copy, availableActions: ["mark_read", "dismiss"], target: { type: "candidate_fact", candidateFactId, href: "/profile#candidate-facts" }, createdAt, readAt: null, resolvedAt: null })).toMatchObject({ status: "unread", target: { type: "candidate_fact", candidateFactId } });
  });

  it("parses a read source item with run provenance", () => {
    expect(AgentInboxItemSchema.parse({ itemId, runId, kind: "source_attention", status: "read", reasonCode: "SOURCE_HEALTH_ATTENTION", budgetDimension: null, ...copy, availableActions: ["dismiss"], target: { type: "job_source", watchlistItemId, targetId, href: `/profile/targets/${targetId}/watchlist#source-health` }, createdAt, readAt, resolvedAt: null })).toMatchObject({ status: "read", runId, target: { type: "job_source", watchlistItemId, targetId } });
  });

  it("parses unread recommendation and calibration items", () => {
    expect(AgentInboxItemSchema.parse({ itemId, runId: null, kind: "recommendation_list", status: "unread", reasonCode: "RECOMMENDATION_LIST_PUBLISHED", budgetDimension: null, ...copy, availableActions: ["mark_read", "dismiss"], target: { type: "recommendation_list", recommendationListId, targetId, href: `/recommendations?targetId=${targetId}#recommendation-list` }, createdAt, readAt: null, resolvedAt: null })).toMatchObject({ target: { type: "recommendation_list", recommendationListId } });
    expect(AgentInboxItemSchema.parse({ itemId, runId: null, kind: "calibration_proposal", status: "unread", reasonCode: "CALIBRATION_PROPOSAL_CREATED", budgetDimension: null, ...copy, availableActions: ["mark_read", "dismiss"], target: { type: "calibration_proposal", proposalId, targetId, href: `/recommendations?targetId=${targetId}#calibration-proposal` }, createdAt, readAt: null, resolvedAt: null })).toMatchObject({ target: { type: "calibration_proposal", proposalId } });
  });

  it("parses a resolved run item and accepts lifecycle commands", () => {
    expect(AgentInboxItemSchema.parse({ itemId, runId, kind: "run_failed", status: "resolved", reasonCode: "AGENT_RUN_ADAPTER_FAILED", budgetDimension: null, ...copy, availableActions: [], target: { type: "agent_run", runId, href: `/home?runId=${runId}#agent-run` }, createdAt, readAt: null, resolvedAt })).toMatchObject({ status: "resolved", resolvedAt });
    for (const action of ["restart_run", "resume_run", "cancel_run", "mark_read", "dismiss"] as const) expect(AgentInboxActionCommandSchema.parse({ actionId, action })).toEqual({ actionId, action });
    expect(AgentInboxListSchema.parse({ items: [] })).toEqual({ items: [] });
  });

  it("rejects free-form targets, cross-kind targets, inconsistent timestamps, and the former open status", () => {
    const candidate = { itemId, runId: null, kind: "candidate_fact", status: "unread", reasonCode: "CANDIDATE_FACT_PENDING", budgetDimension: null, ...copy, availableActions: ["mark_read", "dismiss"], target: { type: "candidate_fact", candidateFactId, href: "/profile#candidate-facts" }, createdAt, readAt: null, resolvedAt: null };
    expect(AgentInboxItemSchema.safeParse({ ...candidate, target: { type: "candidate_fact", candidateFactId, href: "https://example.test" } }).success).toBe(false);
    expect(AgentInboxItemSchema.safeParse({ ...candidate, target: { type: "agent_run", runId, href: `/home?runId=${runId}#agent-run` } }).success).toBe(false);
    expect(AgentInboxItemSchema.safeParse({ ...candidate, status: "read", readAt: null }).success).toBe(false);
    expect(AgentInboxItemSchema.safeParse({ ...candidate, status: "resolved", resolvedAt: "2026-09-03T23:59:00.000Z" }).success).toBe(false);
    expect(AgentInboxItemSchema.safeParse({ ...candidate, status: "open" }).success).toBe(false);
  });
});

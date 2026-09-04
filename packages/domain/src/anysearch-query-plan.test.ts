import { describe, expect, it } from "vitest";
import {
  ANYSEARCH_PUBLIC_JOB_QUERY_PLATFORM_POLICY,
  ANYSEARCH_PUBLIC_JOB_QUERY_POLICY_VERSION,
  createAnySearchQueryAudit,
  createAnySearchQueryPlan,
} from "./anysearch-query-plan";

const targetId = "8d9f0bc3-4868-49aa-947c-c7e5444e0635";

function snapshots() {
  return {
    targetSnapshot: {
      targetId,
      version: 3,
      priority: "primary" as const,
      state: "active" as const,
      constraints: {
        roleFamily: "AI 应用工程师",
        seniority: "高级",
        locations: ["上海", "杭州"],
        workModes: ["hybrid", "remote"] as const,
        relocation: "conditional" as const,
        salary: { minimum: 30_000, maximum: 50_000, period: "month" as const, currency: "CNY" },
        industries: ["人工智能"],
        dealBreakers: {
          excludedCompanies: ["不相关公司"], excludedIndustries: ["外包"], excludeOutsourcing: true,
          excludeDispatch: true, excludeHeadhunter: true, other: ["不应进入查询"],
        },
      },
    },
    profileSnapshot: { targetId, version: 4, confirmedActiveSkillNames: ["TypeScript", "React"] },
    watchlistSnapshot: { targetId, version: 0, companies: [] },
  };
}

describe("AnySearch query planner", () => {
  it("在空 Watchlist 时只生成固定策略的通用与四条站点查询，并拒绝动态站点域", () => {
    const plan = createAnySearchQueryPlan(snapshots());

    expect(ANYSEARCH_PUBLIC_JOB_QUERY_POLICY_VERSION).toBe("anysearch-public-job-query-policy-v1");
    expect(plan.queries).toHaveLength(5);
    expect(plan.queries.map(({ kind }) => kind)).toEqual([
      "general", "site_constrained", "site_constrained", "site_constrained", "site_constrained",
    ]);
    expect(plan.queries.slice(1).map(({ allowedSiteDomains }) => allowedSiteDomains)).toEqual(
      ANYSEARCH_PUBLIC_JOB_QUERY_PLATFORM_POLICY.platforms.map(({ allowedSiteDomains }) => allowedSiteDomains),
    );
    expect(plan.queries.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(plan).toMatchObject({ provider: "anysearch", batchSize: 5, maxVerificationCandidates: 10 });
    expect(() => createAnySearchQueryPlan({ ...snapshots(), allowedSiteDomains: ["attacker.example"] } as never)).toThrow();
  });

  it("按冻结 Watchlist 顺序最多追加五条公司查询，并保持所有数值上限", () => {
    const plan = createAnySearchQueryPlan({
      ...snapshots(),
      watchlistSnapshot: {
        targetId,
        version: 9,
        companies: ["一", "二", "三", "四", "五", "六"].map((canonicalCompanyName, index) => ({
          watchlistItemId: `00000000-0000-4000-8000-00000000000${index + 1}`,
          canonicalCompanyName: `公司${canonicalCompanyName}`,
          allowedDomains: [`company-${index + 1}.example.com`],
        })),
      },
    });

    expect(plan.queries).toHaveLength(10);
    expect(plan.queries.slice(5).map(({ kind }) => kind)).toEqual(Array(5).fill("target_company"));
    expect(plan.queries.slice(5).map(({ targetCompanyNames }) => targetCompanyNames[0])).toEqual([
      "公司一", "公司二", "公司三", "公司四", "公司五",
    ]);
    expect(plan.queries.map(({ resultLimit }) => resultLimit)).toEqual(Array(10).fill(5));
    expect(plan.maxVerificationCandidates).toBe(10);
    expect(plan.queries.every(({ allowedSiteDomains }) => allowedSiteDomains.length <= 5)).toBe(true);
  });

  it("将公司域输出限制为前五个，但让全部已批准域参与公司指纹且不影响固定站点查询", () => {
    const allowedDomains = [
      "one.example.com", "two.example.com", "three.example.com", "four.example.com", "five.example.com", "six.example.com",
    ];
    const input = {
      ...snapshots(),
      watchlistSnapshot: {
        targetId,
        version: 1,
        companies: [{
          watchlistItemId: "11111111-1111-4111-8111-111111111111",
          canonicalCompanyName: "域名公司",
          allowedDomains,
        }],
      },
    };
    const plan = createAnySearchQueryPlan(input);
    const revised = createAnySearchQueryPlan({
      ...input,
      watchlistSnapshot: {
        ...input.watchlistSnapshot,
        companies: [{ ...input.watchlistSnapshot.companies[0]!, allowedDomains: [...allowedDomains.slice(0, 5), "changed.example.com"] }],
      },
    });

    expect(plan.queries[5]!.allowedSiteDomains).toEqual(allowedDomains.slice(0, 5));
    expect(revised.queries[5]!.allowedSiteDomains).toEqual(allowedDomains.slice(0, 5));
    expect(revised.queries[5]!.stableFingerprint).not.toBe(plan.queries[5]!.stableFingerprint);
    expect(plan.queries.slice(1, 5).map(({ allowedSiteDomains }) => allowedSiteDomains)).toEqual(
      ANYSEARCH_PUBLIC_JOB_QUERY_PLATFORM_POLICY.platforms.map(({ allowedSiteDomains }) => allowedSiteDomains),
    );
    expect(revised.queries.slice(1, 5)).toEqual(plan.queries.slice(1, 5));
  });

  it("为同名同域但不同 Watchlist 条目生成不同的公司查询标识", () => {
    const plan = createAnySearchQueryPlan({
      ...snapshots(),
      watchlistSnapshot: {
        targetId,
        version: 1,
        companies: [
          { watchlistItemId: "11111111-1111-4111-8111-111111111111", canonicalCompanyName: "同名公司", allowedDomains: ["same.example.com"] },
          { watchlistItemId: "22222222-2222-4222-8222-222222222222", canonicalCompanyName: "同名公司", allowedDomains: ["same.example.com"] },
        ],
      },
    });

    expect(plan.queries[5]!.stableFingerprint).not.toBe(plan.queries[6]!.stableFingerprint);
    expect(plan.queries[5]!.queryId).not.toBe(plan.queries[6]!.queryId);
  });

  it("从合约允许的最大快照确定性地生成 roleFamily 优先且不超过 500 字符的查询", () => {
    const roleFamily = "r".repeat(200);
    const maximumAllowedDomains = Array.from({ length: 20 }, (_, index) => `${index}${"d".repeat(63 - String(index).length)}.${"d".repeat(63)}.${"d".repeat(63)}.com`);
    const plan = createAnySearchQueryPlan({
      ...snapshots(),
      targetSnapshot: {
        ...snapshots().targetSnapshot,
        constraints: {
          ...snapshots().targetSnapshot.constraints,
          roleFamily,
          seniority: "s".repeat(200),
          locations: Array.from({ length: 20 }, (_, index) => `${index}${"l".repeat(200 - String(index).length)}`),
          workModes: ["onsite", "hybrid", "remote"] as const,
        },
      },
      profileSnapshot: { targetId, version: 1, confirmedActiveSkillNames: Array.from({ length: 10 }, (_, index) => `${index}${"k".repeat(99)}`) },
      watchlistSnapshot: {
        targetId,
        version: 1,
        companies: [{
          watchlistItemId: "11111111-1111-4111-8111-111111111111",
          canonicalCompanyName: "c".repeat(200),
          allowedDomains: maximumAllowedDomains,
        }],
      },
    });

    const companyQuery = plan.queries[5]!;
    const plannedSiteTokens = plan.queries.flatMap(({ query }) => query.split(" ").filter((term) => term.startsWith("site:")));

    expect(plan.queries.every(({ query }) => query.length <= 500 && query.startsWith(roleFamily))).toBe(true);
    expect(plan.queries.slice(1, 5).every(({ query }, index) => query.includes(
      `site:${ANYSEARCH_PUBLIC_JOB_QUERY_PLATFORM_POLICY.platforms[index]!.allowedSiteDomains[0]}`,
    ))).toBe(true);
    expect(companyQuery.query).toContain(`${roleFamily} ${"c".repeat(200)}`);
    expect(companyQuery.allowedSiteDomains).toEqual(maximumAllowedDomains.slice(0, 5));
    expect(plannedSiteTokens.every((token) => [
      ...ANYSEARCH_PUBLIC_JOB_QUERY_PLATFORM_POLICY.platforms.flatMap(({ allowedSiteDomains }) => allowedSiteDomains),
      ...companyQuery.allowedSiteDomains,
    ].includes(token.slice("site:".length)))).toBe(true);
    expect(createAnySearchQueryPlan({
      ...snapshots(),
      targetSnapshot: {
        ...snapshots().targetSnapshot,
        constraints: { ...snapshots().targetSnapshot.constraints, roleFamily, seniority: "s".repeat(200), locations: Array.from({ length: 20 }, (_, index) => `${index}${"l".repeat(200 - String(index).length)}`), workModes: ["onsite", "hybrid", "remote"] as const },
      },
      profileSnapshot: { targetId, version: 1, confirmedActiveSkillNames: Array.from({ length: 10 }, (_, index) => `${index}${"k".repeat(99)}`) },
      watchlistSnapshot: { targetId, version: 1, companies: [{ watchlistItemId: "11111111-1111-4111-8111-111111111111", canonicalCompanyName: "c".repeat(200), allowedDomains: maximumAllowedDomains }] },
    })).toEqual(plan);
  });

  it("为相同快照生成相同 UUID 与指纹，并在已批准版本变化时更新相关指纹", () => {
    const input = snapshots();
    const first = createAnySearchQueryPlan(input);
    const second = createAnySearchQueryPlan(input);
    const revised = createAnySearchQueryPlan({
      ...input,
      profileSnapshot: { ...input.profileSnapshot, version: input.profileSnapshot.version + 1 },
    });
    const revisedFacts = createAnySearchQueryPlan({
      ...input,
      targetSnapshot: {
        ...input.targetSnapshot,
        constraints: { ...input.targetSnapshot.constraints, roleFamily: "AI 平台工程师" },
      },
    });

    expect(second).toEqual(first);
    expect(first.queries.every(({ queryId }) => /^[0-9a-f-]{36}$/u.test(queryId))).toBe(true);
    expect(first.queries.every(({ queryId }) => queryId[14] === "8" && /^[89ab]$/u.test(queryId[19]!))).toBe(true);
    expect(first.queries.every(({ stableFingerprint }) => /^[a-f0-9]{64}$/u.test(stableFingerprint))).toBe(true);
    expect(revised.queries.map(({ stableFingerprint }) => stableFingerprint)).not.toEqual(first.queries.map(({ stableFingerprint }) => stableFingerprint));
    expect(revisedFacts.queries.map(({ stableFingerprint }) => stableFingerprint)).not.toEqual(first.queries.map(({ stableFingerprint }) => stableFingerprint));
    expect(revised.queries.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it("一次只使用一个主或次目标的事实，并拒绝不匹配的 targetId", () => {
    const primary = snapshots();
    const secondaryTargetId = "33333333-3333-4333-8333-333333333333";
    const secondary = {
      targetSnapshot: {
        ...primary.targetSnapshot,
        targetId: secondaryTargetId,
        priority: "secondary" as const,
        constraints: { ...primary.targetSnapshot.constraints, roleFamily: "全栈工程师", locations: ["北京"] },
      },
      profileSnapshot: { targetId: secondaryTargetId, version: 1, confirmedActiveSkillNames: ["Go"] },
      watchlistSnapshot: { targetId: secondaryTargetId, version: 0, companies: [] },
    };

    const primaryPlan = createAnySearchQueryPlan(primary);
    const secondaryPlan = createAnySearchQueryPlan(secondary);

    expect(primaryPlan.queries.every(({ query }) => !query.includes("全栈工程师") && !query.includes("北京") && !query.includes("Go"))).toBe(true);
    expect(secondaryPlan.queries.every(({ query }) => !query.includes("AI 应用工程师") && !query.includes("上海") && !query.includes("TypeScript"))).toBe(true);
    expect(() => createAnySearchQueryPlan({
      ...primary,
      profileSnapshot: { ...primary.profileSnapshot, targetId: secondaryTargetId },
    })).toThrow("ANYSEARCH_QUERY_PLAN_TARGET_MISMATCH");
  });

  it("只使用允许的目标事实和十个已确认技能，并从查询审计排除 PII 与自由文本", () => {
    const privateEmail = "private.person@example.com";
    const privateFreeText = "private free form sentinel";
    const input = snapshots();
    const restricted = {
      ...input,
      targetSnapshot: {
        ...input.targetSnapshot,
        constraints: {
          ...input.targetSnapshot.constraints,
          salary: { minimum: 1, maximum: 2, period: "month" as const, currency: "USD" },
          industries: [privateEmail],
          dealBreakers: {
            ...input.targetSnapshot.constraints.dealBreakers,
            excludedCompanies: [privateEmail], other: [privateFreeText],
          },
        },
      },
      profileSnapshot: {
        ...input.profileSnapshot,
        confirmedActiveSkillNames: Array.from({ length: 10 }, (_, index) => `已确认技能${index + 1}`),
      },
    };
    const baseline = createAnySearchQueryPlan({
      ...restricted,
      targetSnapshot: { ...restricted.targetSnapshot, constraints: { ...restricted.targetSnapshot.constraints, industries: [], dealBreakers: { ...restricted.targetSnapshot.constraints.dealBreakers, excludedCompanies: [], other: [] } } },
    });
    const plan = createAnySearchQueryPlan(restricted);
    const audit = createAnySearchQueryAudit({ query: plan.queries[0], leadCount: 1, verificationCandidateCount: 2 });
    const serialized = JSON.stringify({ plan, audit });

    expect(serialized).not.toContain(privateEmail);
    expect(serialized).not.toContain(privateFreeText);
    expect(plan.queries.map(({ stableFingerprint }) => stableFingerprint)).toEqual(baseline.queries.map(({ stableFingerprint }) => stableFingerprint));
    expect(plan.queries.every(({ query }) => query.includes("已确认技能10"))).toBe(true);
    expect(() => createAnySearchQueryPlan({
      ...restricted,
      profileSnapshot: { ...restricted.profileSnapshot, confirmedActiveSkillNames: Array.from({ length: 11 }, (_, index) => `技能${index + 1}`) },
    })).toThrow();
    expect(audit).toEqual({
      queryId: plan.queries[0]!.queryId,
      kind: "general",
      stableFingerprint: plan.queries[0]!.stableFingerprint,
      leadCount: 1,
      verificationCandidateCount: 2,
    });
  });

  it("审计投影严格脱敏，并拒绝超出线索与验证候选上限的计数", () => {
    const query = createAnySearchQueryPlan(snapshots()).queries[0]!;

    expect(createAnySearchQueryAudit({ query, leadCount: 5, verificationCandidateCount: 10 })).toEqual({
      queryId: query.queryId,
      kind: query.kind,
      stableFingerprint: query.stableFingerprint,
      leadCount: 5,
      verificationCandidateCount: 10,
    });
    expect(() => createAnySearchQueryAudit({ query, leadCount: 6, verificationCandidateCount: 0 })).toThrow();
    expect(() => createAnySearchQueryAudit({ query, leadCount: 0, verificationCandidateCount: 11 })).toThrow();
    expect(() => createAnySearchQueryAudit({
      query, leadCount: 0, verificationCandidateCount: 0, rawQuery: "private person@example.com",
    })).toThrow();
  });
});

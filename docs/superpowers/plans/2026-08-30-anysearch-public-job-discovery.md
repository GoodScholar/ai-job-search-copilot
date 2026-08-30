# AnySearch 公开互联网岗位发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Issue #30「MVP 15：通过 AnySearch 发现并验证公开互联网岗位」：以不可变 v4 分层公开岗位发现运行组合既有 Greenhouse/ATS 与 AnySearch 分支。AnySearch 只能发现未验证线索；仅本地来源安全与岗位页验证边界可建立真实来源发布记录，并保持 v1–v3 契约及恢复兼容。

**Architecture:** v4 固定为 `layered-public-job-discovery-v1`。查询规划从经确认的求职目标与符合条件的 Watchlist 生成有界、可复现的 AnySearch 查询；候选 URL 依次经过安全预检、AnySearch `/extract`、本地安全抓取、最终 URL 验证与 DOM 岗位页分类。线索、归因和诊断与真实来源、来源健康分离；每一次物理搜索、提取和本地抓取都独立占用预算并保存 checkpoint。

**Tech Stack:** TypeScript、Zod、Drizzle/PostgreSQL、NestJS/Fastify、Next.js 16/React 19、Vitest/Testcontainers、Playwright、Redis、MinIO。

**Sources:** GitHub Issue [GoodScholar/ai-job-search-copilot#30](https://github.com/GoodScholar/ai-job-search-copilot/issues/30)；[AnySearch API Reference](https://www.anysearch.com/docs)。固定审查基线为 `3a1a3940773921a1a03c3b25ea7baa378c025e83`；审批权威为 supervisor task `01a0478f-f8f6-7d81-aded-7d229c0ee6f3`。

## Global Constraints

- [ ] HEAD 必须基于精确提交 `3a1a3940773921a1a03c3b25ea7baa378c025e83`；不得 push、创建 PR、merge 或开始另一个 Issue。
- [ ] ADR 0022 与 ADR 0028 是不可变历史。新增一份 superseding ADR，且只替代其 Watchlist-only 自动发现范围和 user/Watchlist-only URL-capability 条款。
- [ ] 一个已发现候选只为其单一安全规范化 URL 授予一次验证尝试能力；页面文本、链接、重定向、搜索结果和提取结果均不得扩大能力，跨主机重定向继续拒绝。
- [ ] `CONTEXT.md` 只定义岗位发现线索、发现归因和发现诊断的概念与不变量；不得包含字段或实现状态机。
- [ ] 冻结 v1–v3；新增不可变 v4 `layered-public-job-discovery-v1`，在同一持久化运行中组合 Greenhouse/ATS 与 AnySearch 分支。
- [ ] 岗位发现线索绝不是来源发布记录、来源发布版本、岗位机会或 Agent 运行结果。只有本地抓取并验证的最终/规范 URL 可创建来源发布版本。
- [ ] 发现归因记录供应方/查询如何发现已验证来源发布版本，绝不替代真实来源身份；发现诊断属于 Agent 运行/线索，绝不写入 `job_source_health_checks` 或 Watchlist-only 诊断。
- [ ] 只持久化安全规范化候选 URL 与稳定指纹；持久化前去除凭据、会话令牌、片段及敏感追踪参数。搜索标题/摘要和提取内容绝不成为来源原始内容。
- [ ] 验证顺序固定为：候选 URL 安全预检 → AnySearch `/extract` → 本地安全抓取 → 最终 URL 验证 → DOM/岗位页分类。`/extract` 只接收候选 URL，结果是不可信辅助数据。
- [ ] 查询事实仅限岗位方向、资历、地点、工作方式、最多 10 个已确认活动技能名、Watchlist 公司/域；绝不包含姓名、联系方式、完整简历、证据节选、自由文本 `dealBreakers.other` 或无关目标。
- [ ] 查询计划默认一条通用查询、四条版本化站点限定查询（BOSS、Liepin、Zhaopin、微信招聘 H5）及最多五条 Watchlist 公司查询；最多 10 条查询、客户端每批最多 5 条、每条最多 5 条线索、最多 10 个验证候选、最多 5 个持久化结果。站点域只能来自版本化固定策略/allowlist。
- [ ] 每次物理 `/search`、`/extract` 和本地抓取均独立 reserve/checkpoint/count 预算；并发必须确定、有界、可取消、可重放幂等，并保留原子预算。
- [ ] AnySearch 稳定错误为 `ANYSEARCH_NOT_CONFIGURED`、`ANYSEARCH_AUTH_FAILED`、`ANYSEARCH_RATE_LIMITED`、`ANYSEARCH_QUOTA_EXHAUSTED`、`ANYSEARCH_TIMEOUT`、`ANYSEARCH_CANCELLED`、`ANYSEARCH_UNAVAILABLE`、`ANYSEARCH_INVALID_RESPONSE`、`ANYSEARCH_POLICY_REJECTED`。
- [ ] 官方机器契约固定为成功 envelope `code=0/message/request_id/data`；HTTP 402 quota symbols 映射 `ANYSEARCH_QUOTA_EXHAUSTED`；HTTP 429 rate symbols 映射 `ANYSEARCH_RATE_LIMITED`。绝不按 `message` 分类，绝不猜测权威 schema 不存在的 JSON symbol 字段。匿名模式禁用；402 匿名响应中的任何凭据必须丢弃，绝不记录或持久化。
- [ ] 缺少 AnySearch key 只以 `ANYSEARCH_NOT_CONFIGURED` 失败该分支；若 Greenhouse/ATS 成功，运行状态为 `completed_with_source_issues`。同一根因只聚合为一个脱敏运行级 attention item，不能每条查询各建一个。
- [ ] 线索持久化投影为 30 天 `expiresAt`，不做后台 sweep；已验证的 owner-bound 关联由数据库约束或同一事务内的强校验保证。
- [ ] 登录墙、列表页、过期页、不安全页及内容不足只保留 rejected Lead，不能创建 Source Posting、Opportunity 或 AgentRunResult。
- [ ] 测试使用公开 seam，以一个纵切的 Red → Green TDD 切片逐步实现；实现与测试执行使用 `gpt-5.6-terra/high`，规划与最终审查使用 `gpt-5.6-sol/high`。

## Task 1: Slice 0 — 冻结领域与获批实施计划

**Files:** 新建 `docs/adr/0033-use-layered-verified-public-job-discovery.md`；修改 `CONTEXT.md`；新建本计划。

- [ ] 新增 superseding ADR，保留 ADR 0022/0028 历史不变，并冻结单一规范 URL/单次验证能力、不可扩权与跨主机重定向拒绝。
- [ ] 仅在 `CONTEXT.md` 加入岗位发现线索、发现归因、发现诊断概念与不变量，且明确诊断与来源健康分离。
- [ ] 将全部 Global Constraints、Task 1–12、固定基线、402/429 契约、迁移/归因模型、局部失败/预算/取消语义、全量验收和 GitHub 关闭门禁写入本 tracked plan。
- [ ] 运行现有根 `pnpm test` 基线；用 focused read/diff 检查文档命名、链接和仅预期改动，然后只提交三份 tracked 文档。

## Task 2: Slice 1 — 不可变 v4 契约

**Files:** v4 contracts、fixtures 与契约测试的最小增量。

- [ ] 先在导出的 contracts seam 写 Red 测试：为分层公开发现、Lead、Attribution、Diagnostic、provider error、query taxonomy、每物理调用 checkpoint/budget facts 与 result/source-issue summaries 建版本化 discriminated unions。
- [ ] Green：新增 v4 契约，保持每个 v1–v3 fixture 的 parsing/recovery；只做 additive/versioned 变更，绝不复用旧字段或让 AnySearch Lead 进入可信来源文档类型。
- [ ] 运行 focused contracts 测试与旧 fixture 回归，记录 Red→Green 证据。

## Task 3: Slice 2 — 版本化查询规划与快照

**Files:** 新 domain query-planner public seam、快照契约与测试。

- [ ] 先写 Red 测试，从一个 primary/secondary target 与符合条件 Watchlist 条目生成确定性 v4 query plan。
- [ ] Green：执行隐私排除、最多 10 个 confirmed active skills、版本化固定 BOSS/Liepin/Zhaopin/微信 H5 site allowlist、全部数值上限、稳定指纹及 target-bound immutable run snapshot。
- [ ] 证明返回 domains 或自由文本不能扩展 allowlist，运行 planner/snapshot focused tests。

## Task 4: Slice 3 — 共享安全岗位页验证器

**Files:** `source-access` public seam、API thin adapter、Worker 共用 verifier 与 fixtures/tests。

- [ ] 先写 Red 测试，将可复用安全抓取与分类核心迁移/重建为 API 与 Worker 共享能力。
- [ ] Green：保留 DNS/IP/private-network 拒绝、DNS pinning、同 host redirect、timeout/byte/concurrency 控制、canonical/final URL 处理、隐藏/script 内容排除，并增加 `AbortSignal` 传递。
- [ ] 覆盖固定 BOSS/Liepin/Zhaopin/微信 H5 岗位 fixtures、登录墙、列表、过期、不安全、内容不足和跨 host redirect；API 退化为 thin adapter 且无行为回归。

## Task 5: Slice 4 — AnySearch Adapter

**Files:** 显式 AnySearch adapter interface、`/v1/search` 与 `/v1/extract` 实现、契约/adapter tests。

- [ ] 先在 adapter seam 写 Red 测试，覆盖客户端每批最多五个独立搜索及部分结果、AbortSignal 取消、timeout、严格 success envelope、稳定错误映射与物理调用 hooks。
- [ ] Green：实现 `/v1/search` 和 `/v1/extract`；402/429 仅按 HTTP status 和已记录 machine field 映射，绝不检查 `message` 或猜测 JSON symbol。
- [ ] 禁用 anonymous requests，key 只在 runtime 存在，日志/错误脱敏，丢弃 credential-bearing response data；为每个物理请求暴露 reserve/checkpoint/count hook 并完成 focused 回归。

## Task 6: Slice 5 — Lead 与 Attribution 持久化

**Files:** Drizzle schema、`0024` migration、snapshot/journal metadata、domain persistence 与 repository integration tests。

- [ ] 先写 migration/repository Red 测试：规范化/指纹 Lead、rejected/verified outcome、30 天 expiration projection 与 owner-bound Attribution 指向真实 Source Posting Version。
- [ ] Green：新增 schema 与 migration，使用数据库约束或同一事务强校验保证 owner-bound linkage，令 retries 幂等；绝不新增 sweep。
- [ ] 证明 credential/token/fragment/tracking URL 与 AnySearch content 不会持久化，诊断不进入 source-health tables；运行迁移、repository integration 与 Drizzle 验证。

## Task 7: Slice 6 — 已验证持久化门禁

**Files:** domain persistence bridge、integration tests 与必要 source persistence seams。

- [ ] 先写 Red 测试，唯一桥接必须严格经过：preflighted candidate → extract auxiliary data → locally fetched VerifiedJobPage → true canonical/final source identity → Source Posting Version + Attribution。
- [ ] Green：保持 canonical dedup 与原子性；证明每个 rejected state 不创建 Source Posting、Opportunity、AgentRunResult。
- [ ] 证明 AnySearch 仅为 attribution，绝不成为 `sourceKind`、`sourceId`、raw content 或 canonical source host；运行 domain/integration TDD 回归。

## Task 8: Slice 7 — 持久化 v4 分层工作流

**Files:** Agent Run processor/workflow public seam、运行详情/attention rendering 与测试。

- [ ] 先写 Red 测试，把 Greenhouse/ATS 与 AnySearch 纳入同一个 v4 durable orchestration。
- [ ] Green：每个物理 search/extract/fetch 独立 reserve budget/checkpoint；取消、暂停、retry、recovery 保持确定性和 replay-idempotency。
- [ ] 诊断建模在 Agent Run/Lead，Watchlist health 语义不变；聚合相同根因，把脱敏 run-level attention 路由到正确运行详情目标。可信来源成功而 AnySearch 缺失/失败时完成为 source issues；全部失败按 retryability 与预算规则处理。

## Task 9: Slice 8 — Runtime 与调度接线

**Files:** v4 execution mode/resolver/module/runtime config、schedule integration tests。

- [ ] 先写 focused integration Red 测试，接入 v4 execution mode/resolver/module/runtime config 与 schedule 行为。
- [ ] Green：生产使用 v4 layered discovery，既有 fake 和 v3 source-health phase 保持兼容；缺 key 只产生 `ANYSEARCH_NOT_CONFIGURED`，绝不发 anonymous traffic，也不阻止 Greenhouse/ATS 成功。
- [ ] 证明没有 Watchlist 时 v4 仍可进行 general/site discovery，只有 company-target queries 依赖 Watchlist；运行 runtime/scheduling 回归。

## Task 10: Slice 9 — Fake AnySearch Playwright 验收

**Files:** dedicated Fake AnySearch local-runtime phase/config/runner、Playwright spec 与固定 fixtures。

- [ ] 增加 Fake AnySearch local-runtime phase，并在要求的浏览器项目中执行专用 Playwright spec。
- [ ] 固定 fixtures 覆盖：有界批次、全部 platform query 类型、验证顺序、canonical dedup、部分 query 失败、缺 key 降级、一个聚合 attention item、登录/列表/过期/不安全/内容不足 rejected Lead、真实来源身份、独立 attribution，以及未验证/rejected Lead 没有 Opportunity/Result。
- [ ] 使用真实 Web/API/Worker/Postgres/Redis/MinIO 边界，仅伪造 AnySearch 外部调用；记录 Desktop Chrome 与 Mobile Safari 结果。

## Task 11: 完整验证与双轴审查

- [ ] 运行 fresh focused tests、根 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、migration/Drizzle validation 与 required Fake AnySearch Playwright phase。
- [ ] 用 `gpt-5.6-sol/high` 独立按 Standards 与 Spec 两轴审查固定 diff `3a1a3940773921a1a03c3b25ea7baa378c025e83..HEAD`。
- [ ] 由 `gpt-5.6-terra/high` 修复所有 Critical、Important、Minor finding，重新做两轴审查直至全部计数为零；最终修复后重跑完整验收套件。

## Task 12: 证据、干净工作树与关闭 Issue

- [ ] 检查相对固定基线的最终 diff，确认无 secrets 或无关改动，提交所有预期变更，且 `git status --short` 为空。
- [ ] 仅在 fresh full verification 与两份 0/0/0 review 后，向 GitHub Issue #30 发布简洁证据并关闭 Issue。
- [ ] 不得 push、创建 PR、merge 或开始另一个 Issue。

## Final validation gate

```bash
git merge-base --is-ancestor 3a1a3940773921a1a03c3b25ea7baa378c025e83 HEAD
DOCKER_API_VERSION=1.51 pnpm test
pnpm typecheck
pnpm lint
pnpm build
DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- anysearch-public-job-discovery.spec.ts --project="Desktop Chrome" --project="Mobile Safari"
git diff --check
git status --short
```

关闭前必须保留上述命令结果、migration/Drizzle 验证、Fake AnySearch acceptance 证据以及固定 diff 的 Standards/Spec 双轴 0/0/0 审查记录；随后才可评论并关闭 GitHub Issue #30。

# Issue #53 一键生成完整推荐结果 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 目标求职者可从求职工作台启动、恢复和控制一次完整的推荐运行，并收到有岗位的推荐清单或有证据的“暂无推荐”。

**Architecture:** 以现有岗位发现根 `agent_runs` 为逻辑运行身份，新增显式 `parent_run_id` 连接其自动深度匹配子运行；新 `recommendation_results` 和启动命令表只记录不可变结果与幂等事实。`RecommendationRuns` 领域边界统一准备摘要、启动、查询、控制和五阶段投影；Worker 在原有持久化/claim fence 之内完成资格门槛、粗排、深度匹配和原子发布，Web 只轮询服务端权威投影。

**Tech Stack:** pnpm workspace、TypeScript、Zod 4、Drizzle/PostgreSQL、NestJS/Fastify、BullMQ、Next.js 16、React 19、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-06-issue-53-one-click-recommendation-design.md`

## Global Constraints

- 沿用 `CONTEXT.md` 的领域术语；页面不向用户暴露 Agent、队列、Adapter、workflow、claim 或模型实现词汇。
- 逻辑运行 ID 必须等于发现根运行 ID；深度匹配仍是独立预算、独立恢复边界的自动子运行。
- 所有启动状态由服务端重新读取并冻结；客户端不得提交账户、目标、预算、来源、工作流或模型配置。
- 不生成定制简历、投递准备包、外部页面填写、提交、邮件或招聘者联系。
- 所有读取/BFF 响应为 `Cache-Control: no-store`；错误不得反射上游正文或不可信内容。
- 任何新行为先写测试、确认测试因缺少行为而失败，再写最小实现；同一时间只运行一条重叠的测试命令。
- 账户全局停止/解除语义已于 2026-09-12 获批，以 spec 的“账户全局停止”为准；所有 legacy 和新推荐运行均受约束。
- RED 必须到达业务断言；模块缺失、导入错误、fixture 不合法、数据库未启动均不是有效 RED。新模块先提供可导入的最小类型/导出，再验证缺少目标行为；本条覆盖下方早期草图中相反的 Expected 描述。

## 当前进度与执行顺序（2026-09-12）

Task 1、Task 2 已完成，当前 HEAD 为 `ed838ea`；两任务保留原编号与历史步骤，不重做迁移 0049。Task 3–10 尚未实施。新增前置顺序为 **Task 11 → Task 12 → Task 13 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9 → Task 10**。设计与最终审查使用 Astra/medium，实现、测试及修复使用 Terra/high；每个切片独立 TDD 与既定双轴审查，测试单进程串行。详细计划由主代理交接，本文更新不代表已实施或验收。

Task 11 交付持久控制及命令；Task 12 交付全部现有执行路径的停止屏障；Task 13 交付账户页面控制入口。Task 3–10 接入这些已存在的接口，不再假设全局停止等待裁定。

---

## File structure

- `packages/contracts/src/recommendation-runs.ts`：严格的准备、逻辑运行、阶段、失败、结果和命令 HTTP 契约。
- `packages/database/src/schema.ts` 与 `packages/database/migrations/0049_recommendation_runs.sql`：父子运行、命令和不可变结果的约束及迁移。
- `packages/domain/src/recommendation-runs.ts`：唯一的应用级查询/命令 seam，派生投影并执行启动/控制幂等。
- `packages/domain/src/agent-run-processor.ts`、`deep-match-agent-runs.ts`：将根运行的发现结果限定到本次运行，创建唯一自动子运行，并围绕发布加 fence。
- `apps/api/src/recommendation-runs/*`：认证 REST 入口和依赖注入。
- `apps/web/app/api/recommendation-runs/**/route.ts`、`apps/web/lib/server/recommendation-runs.ts`：同源 BFF 与服务端数据访问。
- `apps/web/components/workbench/recommendation-run-panel.tsx`：启动摘要、确认、五阶段状态、控制及可见页轮询。
- `apps/web/app/(workbench)/home/page.tsx`、`workbench-home-view.tsx`、`apps/web/app/(workbench)/recommendations/page.tsx`：接入工作台和结果视图。
- `packages/database/migrations/0050_account_run_control.sql`、`packages/contracts/src/account-run-policies.ts`、`packages/domain/src/account-run-control.ts`：账户控制字段、窄幂等事实与运行开关；不修改策略 settings 修订语义。
- 现有 `account-run-policies` API、`apps/web/app/api/account/run-policy` BFF、`account-run-policy-view.tsx`：控制状态读取和停止/解除入口。

### Task 11: 持久账户停止命令与独立控制版本（前置于 Task 3）

**Files:**
- Modify: `packages/contracts/src/account-run-policies.ts`、`packages/contracts/src/account-run-policies.test.ts`
- Modify: `packages/database/src/schema.ts`、`packages/database/migrations/meta/_journal.json`
- Create: `packages/database/migrations/0050_account_run_control.sql`、`packages/database/src/account-run-control.migrate.integration.test.ts`
- Create: `packages/domain/src/account-run-control.ts`、`packages/domain/src/account-run-control.integration.test.ts`
- Modify: `packages/domain/src/agent-run-control.ts`、`packages/domain/src/account-run-policies.ts`、`packages/domain/src/account-run-policies.integration.test.ts`、`packages/domain/package.json`
- Modify: `packages/domain/src/audit-trail.ts`、`packages/domain/src/audit-trail.integration.test.ts`（既有严格审计事件/元数据 schema）；`packages/contracts/src/job-discovery-schedules.ts`、`packages/contracts/src/job-discovery-schedules.test.ts`（增加 Task 12 的两项 skipReason）

**Interfaces:**

```ts
// contracts/account-run-policies.ts；三个 schema 均 strict，日期为 ISO 或 null。
export type AccountRunControlState = {
  stoppedAt: string | null;
  controlVersion: number;
  scheduleResumeAfter: string | null;
};
export type AccountRunControlCommand = {
  commandId: string; // UUID
  expectedVersion: number; // 非负整数，唯一对应 controlVersion
  action: "stop" | "release";
};
export type AccountRunControlResponse = { applied: boolean; state: AccountRunControlState };
// 导出 AccountRunControlStateSchema / AccountRunControlCommandSchema / AccountRunControlResponseSchema。
// domain/account-run-control.ts
export type AccountRunControlRow = {
  stoppedAt: Date | null; controlVersion: number; scheduleResumeAfter: Date | null;
};
export async function readAccountRunControlInTransaction(
  tx: Pick<Database, "select">, userId: string,
): Promise<AccountRunControlRow>; // 不拿锁、不写 baseline；没有 policy 行返回三个默认值 null/0/null
export function createAccountRunControl(deps: {
  db: Database; auditTrail: AuditTrail; id: () => string; clock: () => Date;
}): {
  get(input: { userId: string }): Promise<AccountRunControlState>;
  control(input: { userId: string; requestId: string; command: AccountRunControlCommand }): Promise<AccountRunControlResponse>;
};
```

复用现有 policy baseline 初始化，导出窄 `ensureAccountRunPolicyBaselineInTransaction(tx, {userId,id,clock}): Promise<void>`；调用方已持账户锁，不能另开事务。将既有逐运行控制实现抽成 `applyAgentRunControlInTransaction(tx, {userId,requestId,runId,command}, {auditTrail,id,clock}): Promise<{response: ControlAgentRunResponse; wake: boolean}>`，保留幂等、事件、Inbox、审计语义；原 public control 仍负责账户锁与提交后 enqueue。Task 11 的批量 pause 使用同一 seam，物理 commandId 直接用账户 commandId（物理唯一键另含 runId），不复制状态机。

- [ ] **Step 1: 写控制与策略隔离 RED**

沿用 account-run-policies integration 的真实 PG/accounts fixture；本例的 `controls` 是上述 factory，`userId` 是 fixture 已插入账户，`clock` 设为可推进的固定 Date。新增最小可导入类型和 factory 后，运行到以下行为断言。

```ts
const command = { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" as const };
const first = await controls.control({ userId, requestId: crypto.randomUUID(), command });
expect(first).toMatchObject({ applied: true, state: { controlVersion: 1, stoppedAt: expect.any(String) } });
const released = await controls.control({ userId, requestId: crypto.randomUUID(), command: {
  commandId: crypto.randomUUID(), expectedVersion: 1, action: "release",
} });
expect(released.state.stoppedAt).toBeNull();
expect(released.state.scheduleResumeAfter).not.toBeNull();
expect(await controls.control({ userId, requestId: crypto.randomUUID(), command })).toEqual(first);
expect((await controls.get({ userId })).stoppedAt).toBeNull();
```

另测新命令旧版本、同 commandId 不同 action/expectedVersion 均冲突；同状态新命令 applied=false 且不递增版本/重复审计；同键并发一次施加；跨账户独立；stop 与 policy.save 并发两者都保留；无 baseline 首次 stop 可用；queued→paused、running→pause_requested、paused/终态不变、cancel_requested 不被覆盖；release 不改任何 run。读取 get 不创建 baseline。

- [ ] **Step 2: 逐条运行 RED**

Run: `pnpm --filter @job-copilot/domain exec vitest run src/account-run-control.integration.test.ts src/account-run-policies.integration.test.ts src/audit-trail.integration.test.ts --no-file-parallelism`。随后单独执行 Step 4 contracts 和 migration 的目标测试。Expected：新行为断言失败，已有策略行为通过；保存完整日志。

- [ ] **Step 3: 写最小迁移与命令事务**

```sql
alter table account_run_policies add column stopped_at timestamptz;
alter table account_run_policies add column control_version integer not null default 0 check (control_version >= 0);
alter table account_run_policies add column schedule_resume_after timestamptz;
create table account_run_control_commands (
  user_id uuid not null references job_accounts(id),
  command_id uuid not null,
  action varchar(8) not null check (action in ('stop', 'release')),
  expected_version integer not null check (expected_version >= 0),
  applied boolean not null,
  result_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, command_id)
);
```

为 result_snapshot 增加 JSON 对象、字节上限 2048、必要键及类型检查，应用写入前 strict parse AccountRunControlResponseSchema；幂等行拒绝 UPDATE/DELETE。加入 journal，0050 不重写 0049，并在本切片一次性扩展现有 schedule occurrence skip_reason CHECK，允许 `ACCOUNT_RUN_STOPPED`、`ACCOUNT_RUN_SCHEDULE_SKIPPED`；Task 12 不回头改已应用迁移。迁移测试直接验证这两个 skip 原因、未知原因拒绝、负 control_version、错误 action、非法/超长 snapshot、同账户重复键、跨账户合法键、命令更新删除拒绝和历史 policy 默认未停止。

命令事务顺序固定：账户锁 → 读 command（同 action/expectedVersion 返回原 snapshot，否则 ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT）→ 初始化 baseline → 对比 controlVersion（不同为 ACCOUNT_RUN_CONTROL_VERSION_CONFLICT）→ 按当前 stoppedAt 判定 applied → 更新控制字段/逐运行 pause → 写审计/command。实际 stop 设置 stoppedAt=now，release 清空 stoppedAt 且 scheduleResumeAfter=max(旧值, now)，仅实际转换使 controlVersion+1；不改 currentRevisionNumber、policy.version、settings 或 schedule/occurrence。审计新增 `account.run_stopped`/`account.run_stop_released`，元数据仅 commandId、controlVersion、action；没有自由文本原因。

```ts
for (const run of activeRuns) { // 同账户 queued/running，锁内查询
  if (run.controlState === "cancel_requested") continue;
  await applyAgentRunControlInTransaction(tx, {
    userId, requestId, runId: run.id, command: { commandId, action: "pause" },
  }, { auditTrail, id, clock });
}
```

上段使用 control 方法内已解构参数，activeRuns 查询仅 status queued/running；逐运行 seam 的 cancel 优先规则保留。账户 command 表和 run 事件同一事务，异常全部回滚。模块导出 `./account-run-control`，不新增通用命令总线。

- [ ] **Step 4: 逐条 GREEN 与类型检查**

依次运行 `pnpm --filter @job-copilot/contracts exec vitest run src/account-run-policies.test.ts src/job-discovery-schedules.test.ts --no-file-parallelism`、`pnpm --filter @job-copilot/database exec vitest run src/account-run-control.migrate.integration.test.ts --no-file-parallelism`、Step 2 domain 命令；随后依次执行 `pnpm --filter @job-copilot/contracts typecheck`、`pnpm --filter @job-copilot/database typecheck`、`pnpm --filter @job-copilot/domain typecheck`。均需实际业务断言通过。

- [ ] **Step 5: 提交实现，交接双轴审查 commit diff**

```bash
git diff --check
git add packages/contracts/src/account-run-policies.ts packages/contracts/src/account-run-policies.test.ts packages/contracts/src/job-discovery-schedules.ts packages/contracts/src/job-discovery-schedules.test.ts packages/database/src/schema.ts packages/database/migrations/0050_account_run_control.sql packages/database/migrations/meta/_journal.json packages/database/src/account-run-control.migrate.integration.test.ts packages/domain/src/account-run-control.ts packages/domain/src/account-run-control.integration.test.ts packages/domain/src/account-run-policies.ts packages/domain/src/account-run-policies.integration.test.ts packages/domain/src/agent-run-control.ts packages/domain/src/audit-trail.ts packages/domain/src/audit-trail.integration.test.ts packages/domain/package.json
git commit -m "feat: persist account-wide run stop controls"
```

### Task 12: 封住全部执行/发布入口并禁止调度补跑（前置于 Task 3）

**Files:**
- Modify: `packages/domain/src/agent-run-control.ts`、`agent-run-checkpoint.ts`、`agent-run-processor.ts`、`deep-match-agent-runs.ts`、`deep-match-persistence.ts`、`job-discovery-persistence.ts`、`job-discovery-schedules.ts`、`run-preflight.ts`、`account-run-control.ts`
- Modify: `packages/contracts/src/agent-runs.ts` 及相邻测试（稳定 admission 错误）；消费 Task 11 已在 0050/schema/契约加入的两个 skipReason，不改已应用迁移。
- Test: `packages/domain/src/account-run-control.integration.test.ts`、`agent-run-control.integration.test.ts`、`agent-run-processor.integration.test.ts`、`deep-match-persistence.integration.test.ts`、`job-discovery-persistence.integration.test.ts`、`job-discovery-schedules.integration.test.ts`、`run-preflight.integration.test.ts`；使用现有 fixture 增补，不新增万能 mock 框架。

**Interfaces:** 消费 Task 11 的 `readAccountRunControlInTransaction`。新增纯函数及稳定错误：

```ts
export function accountRunAdmissionReason(
  control: AccountRunControlRow, scheduledFor?: Date,
): "ACCOUNT_RUN_STOPPED" | "ACCOUNT_RUN_SCHEDULE_SKIPPED" | null {
  if (control.stoppedAt !== null) return "ACCOUNT_RUN_STOPPED";
  if (scheduledFor && control.scheduleResumeAfter && scheduledFor <= control.scheduleResumeAfter) return "ACCOUNT_RUN_SCHEDULE_SKIPPED";
  return null;
}
export class AccountRunAdmissionError extends Error {
  constructor(public readonly code: "ACCOUNT_RUN_STOPPED" | "ACCOUNT_RUN_SCHEDULE_SKIPPED") { super(code); }
}
```

Domain admission 错误由 API 映射安全 409，调度将两个 code 分别记同名 skipReason。checkpoint 不新增账户生命周期状态，仍返回 paused/cancelled/stale 等既有联合。preflight 复用唯一 `ACCOUNT_RUN_POLICY_BLOCKED` item，summary 为“账户已停止全部运行”，动作 `review_account_run_policy`，不加第八项、不把 controlVersion 塞入旧 policy revision。

- [ ] **Step 1: 写确定性竞态和在途结算 RED**

在现有 processor fixture 用 deferred adapter 控制“调用已开始/允许返回”两个 Promise，启动 processor 后等待 started，执行 stop，再释放 adapter。必须断言后续调用次数不增、list/result/child 不新增、运行暂停且输入/输出 usage 一次结算。并验证 release 先于旧调用返回时，pause_requested 仍收敛暂停；cancel_requested+stop 返回 cancelled。对于失去 claim 的 settleActual，保留已有替代 claim 用量不变断言。

纯 cutoff 测试的输入完整如下：

```ts
const control = { stoppedAt: null, controlVersion: 2, scheduleResumeAfter: new Date("2026-09-12T02:00:00Z") };
expect(accountRunAdmissionReason(control, new Date("2026-09-12T01:00:00Z"))).toBe("ACCOUNT_RUN_SCHEDULE_SKIPPED");
expect(accountRunAdmissionReason(control, new Date("2026-09-12T02:00:00Z"))).toBe("ACCOUNT_RUN_SCHEDULE_SKIPPED");
expect(accountRunAdmissionReason(control, new Date("2026-09-12T03:00:00Z"))).toBeNull();
```

PG 调度测试：固定 08:00 stop，Worker 不调用 materializeDue/dispatchPending，10:00 release，11:00 materialize 09:00 的旧 nextRunAt 并 dispatch；应 skipped、runId=null、没有 run，nextRunAt 为下次未来时刻。再测已物化 pending、重复 stop/release、恰等 cutoff、另一账户、已有 run 的 occurrence 补 dispatched 但 run 不恢复。竞态使用显式屏障按 stop→publish 和 publish→stop 两序测试；前者不发布，后者保留已提交结果。

另测 Worker 停止→账户 stop→claim 过期→Worker 重启 recovery，账户仍停止时即收敛 paused（取消优先则 cancelled），attemptCount 不增、无新外部调用、active duration 最晚结算到旧 claimExpiresAt；不得等待 release。保留旧 invocation 的 settleActual 在收敛后迟到返回的幂等账本测试。

- [ ] **Step 2: 串行运行 RED**

Run: `pnpm --filter @job-copilot/domain exec vitest run src/account-run-control.integration.test.ts src/agent-run-control.integration.test.ts src/agent-run-processor.integration.test.ts src/deep-match-persistence.integration.test.ts src/job-discovery-persistence.integration.test.ts src/job-discovery-schedules.integration.test.ts src/run-preflight.integration.test.ts --no-file-parallelism`。Expected：现有执行路径未读账户状态而产生可复现业务失败。

- [ ] **Step 3: 加账户锁内守卫**

```ts
await acquireAccountAdvisoryLock(tx, userId);
const control = await readAccountRunControlInTransaction(tx, userId);
const reason = accountRunAdmissionReason(control, scheduledFor);
if (reason) throw new AccountRunAdmissionError(reason);
```

代码置于新 start/手动 resume/自动 child 创建的事务中；已持久化命令或运行的同义 replay 先返回原事实，不能因此重新恢复/授权动作。普通 createAgentRunStarter、ensureDeepMatchRunInTransaction 全覆盖，不仅 recommendation purpose。preflight 先查 control 再组合同一个 account policy item。

Worker 守卫清单：process claim（含 queued、过期 running takeover）、renewClaim、每次外部调用前 checkpoint、stepTransition、failOrRetry 的再排队、persistLayeredPublicOutcome、job-discovery-persistence 的 persistSuccessfulDiscovery/persistTrustedLayeredDiscovery、deep-match-persistence 的暂存和 publishStagedRun。沿用各自既有控制返回值/错误类型，不把账户停止误记源失败或预算耗尽。checkpoint 内以 cancel_requested 优先；账户 stopped 或已有 pause_requested 阻止 reservation，并复用暂停收敛代码；settleActual 先记真实成本，再收敛，不能简单在函数最前 return paused。claim 不在 stopped 时新增 attempt；已有 pending control 仍允许 checkpoint 清理、对账和暂停/取消收敛。恢复路径必须先处理过期 claim 的 pending_control，再阻断新 claim：在账户锁下以旧 claimToken 调 checkpoint，无外部动作、无新 attempt，用量结算截至旧租约；账户是否解除不影响此清理。所有结果写入（包括 source-health/fake/greenhouse/layered_public 和旧 manual deep-match）在写业务结果前同锁检查，脱敏诊断/usage 清理仍允许。

调度保持 materializeDue 的 schedule 行锁和 dispatchPending 的 occurrence 行锁。stop/release 仅写 policy/run，绝不在账户锁内碰 schedule/occurrence。starter 在自己的账户事务里，对没有既有 idempotent run 的 scheduledFor 用上方 admissionReason 判定；dispatchPending 捕获其明确错误后更新 skipped，materializeDue 继续按当前 now 推进未来 nextRunAt。因此停止瞬时竞态和离线跨期均由持久 cutoff 兜住，不靠内存、定时器或仅检查当前 stoppedAt；已存在 run 仍走原补 dispatched 路径。禁止外层先拿账户锁再调用自行开启事务的 starter。

恢复沿用现有 pending_control 返回路径：领取事务返回旧 claimToken 并释放账户锁，随后调用会自行开启账户锁事务的 checkpoint.check。不得在仍持锁的事务内调用该 public checkpoint；checkpoint 自己重读 claim/status 后收敛，竞争时返回 stale，不写替代 claim。

- [ ] **Step 4: GREEN 与回归**

重复 Step 2；单独运行 `pnpm --filter @job-copilot/contracts exec vitest run src/agent-runs.test.ts src/job-discovery-schedules.test.ts --no-file-parallelism`；再依次运行 `pnpm --filter @job-copilot/contracts typecheck`、`pnpm --filter @job-copilot/domain typecheck`。确认 fake/greenhouse/layered_public、手动重评、自动 child、过期租约与停止优先级全部有命名断言；不重复运行 Task 11 未改动的迁移。

- [ ] **Step 5: 提交实现，交接双轴审查 commit diff**

```bash
git diff --check
git add packages/domain/src/account-run-control.ts packages/domain/src/agent-run-control.ts packages/domain/src/agent-run-checkpoint.ts packages/domain/src/agent-run-processor.ts packages/domain/src/deep-match-agent-runs.ts packages/domain/src/deep-match-persistence.ts packages/domain/src/job-discovery-persistence.ts packages/domain/src/job-discovery-schedules.ts packages/domain/src/run-preflight.ts packages/contracts/src/agent-runs.ts packages/domain/src/account-run-control.integration.test.ts packages/domain/src/agent-run-control.integration.test.ts packages/domain/src/agent-run-processor.integration.test.ts packages/domain/src/deep-match-persistence.integration.test.ts packages/domain/src/job-discovery-persistence.integration.test.ts packages/domain/src/job-discovery-schedules.integration.test.ts packages/domain/src/run-preflight.integration.test.ts
git commit -m "feat: enforce account stop across execution and schedules"
```

仅暂存上述 Files 中本切片实际变更，执行前检查 status，不能将目录内用户或其他切片改动混入。

### Task 13: 在已有账户运行策略页提供停止/解除（前置于 Task 3）

**Files:**
- Modify: `apps/api/src/account-run-policies/account-run-policies.controller.ts`、`account-run-policies.module.ts`、`account-run-policies.tokens.ts`；在同目录创建/更新 `.controller.test.ts`、`.module.test.ts`
- Create: `apps/web/app/api/account/run-policy/control/route.ts`、`control/route.test.ts`、`apps/web/app/api/account/run-policy/controls/route.ts`、`controls/route.test.ts`
- Modify: `apps/web/lib/server/api-client.ts`、`api-client.test.ts`、`apps/web/lib/server/account-run-policies.ts`
- Modify: `apps/web/app/(workbench)/profile/run-policy/page.tsx`、`apps/web/components/workbench/account-run-policy-view.tsx`、`account-run-policy-view.test.tsx`、`apps/web/e2e/account-run-policy.spec.ts`
- 修改既有 agent-runs 与 recommendation reevaluation API/BFF 的错误白名单及相邻测试，接受 Task 12 的 ACCOUNT_RUN_STOPPED 安全 409。

**Interfaces:** `GET /v1/account/run-policy/control` 返回 AccountRunControlState；`POST /v1/account/run-policy/controls` 接收 AccountRunControlCommand，返回 AccountRunControlResponse（首次、no-op、replay 均 200）。对应 BFF `/api/account/run-policy/control` 和 `/api/account/run-policy/controls`。api-client 导出 `getAccountRunControl`、`controlAccountRuns`，server helper 从 session 读取状态；旧 policy GET/PUT/history 契约不加控制字段。

- [ ] **Step 1: 写 API/BFF/UI 行为 RED**

沿用现有 authenticated request 和 React render fixture，state 取 `{stoppedAt:null,controlVersion:0,scheduleResumeAfter:null}`，POST body 只含三个已定义字段。增加严格负例：userId、settings、reason、负版本、非法 action、非 UUID；未认证 401；两类控制冲突 409；BFF 畸形上游响应安全 502/no-store，不回显正文。

```ts
expect(AccountRunControlCommandSchema.safeParse({
  commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop", userId: crypto.randomUUID(),
}).success).toBe(false);
// 组件停止后 GET 返回当前 stopped 状态；解除后仍显示“旧运行需逐个继续，错过的计划不会补跑”。
expect(screen.getByRole("button", { name: "停止全部运行" })).toBeEnabled();
```

组件测试点击期间禁用，网络重试复用同 commandId，409 后 GET 刷新；policy 保存不会改 controlVersion/stoppedAt；旧 stop replay 响应后 GET 仍显示 released 状态。E2E 在现有页面完成停止→刷新仍停止→解除，验证没有调用任何 run resume。

- [ ] **Step 2: 串行运行 RED**

Run: `pnpm --filter api exec vitest run src/account-run-policies/account-run-policies.controller.test.ts src/account-run-policies/account-run-policies.module.test.ts --no-file-parallelism`，结束后 `pnpm --filter web exec vitest run components/workbench/account-run-policy-view.test.tsx app/api/account/run-policy/control/route.test.ts app/api/account/run-policy/controls/route.test.ts lib/server/api-client.test.ts --no-file-parallelism`。Expected：请求到达 handler/组件断言，未实现的控制行为失败；导入或装配缺失先修复测试脚手架。

- [ ] **Step 3: 最小接线与安全中文**

```ts
const command: AccountRunControlCommand = {
  commandId: crypto.randomUUID(), expectedVersion: state.controlVersion,
  action: state.stoppedAt === null ? "stop" : "release",
};
// 同一次用户意图的重试保留 command；POST 后无论 applied/replay 都 GET 当前权威状态。
```

controller 仅使用 SessionGuard 的 userId，module 注入 Task 11 factory；BFF 沿用已有 session 转发与安全错误白名单。现有账户页单独加载 control 状态，不改变策略历史视图；加载失败显示“运行控制暂不可用”并禁用控制按钮。状态区显示“已停止新动作，正在运行的任务将在安全检查点暂停。已发出的请求可能仍产生费用”，解除说明逐个继续/不补跑；语义按钮、可见焦点、44px 与不抢焦点 aria-live，使用现有样式，不增通用管理台。

- [ ] **Step 4: GREEN 与浏览器验证**

重复 Step 2，随后依次运行 `pnpm --filter web exec playwright test e2e/account-run-policy.spec.ts --workers=1`、`pnpm --filter api typecheck`、`pnpm --filter web typecheck`。不得同时由 Supervisor 再运行重叠测试。

- [ ] **Step 5: 提交实现，交接双轴审查 commit diff**

```bash
git diff --check
git add apps/api/src/account-run-policies apps/web/app/api/account/run-policy apps/web/lib/server/api-client.ts apps/web/lib/server/api-client.test.ts apps/web/lib/server/account-run-policies.ts 'apps/web/app/(workbench)/profile/run-policy/page.tsx' apps/web/components/workbench/account-run-policy-view.tsx apps/web/components/workbench/account-run-policy-view.test.tsx apps/web/e2e/account-run-policy.spec.ts
git commit -m "feat: expose account run stop and release controls"
```

额外暂存本切片实际涉及的 legacy 错误映射文件及相邻测试，核对 diff 后提交。

### Task 1: 定义逻辑推荐运行契约

**执行修正（2026-09-12，Sol 预审）：** 同步扩展 contracts 的 `RunPreflightWorkflowSchema` 和对应测试以接受 `recommendation`，evaluator 行为归 Task 3。Preparation.target 允许 null 且此时报告必须 blocked；已启动 Run.target 必须非空。阶段必须恰好五个、固定顺序且 currentStage/result/failure 与终态一致。测试草图须落实为独立手工 fixture；模块缺失不是有效行为 RED，先建立最小导出，再确认业务断言失败。

Evidence 字段固定为：`discovery.discoveredJobCount`；`sourceCoverage.{plannedTrustedSourceCount,plannedPublicQueryCount,checkedBranchCount,credibleBranchCount,verifiedJobCount}`；`coverageLosses: {code,affectedCount,retryable}[]`（最多 32 项，code 使用已知稳定原因枚举）；`qualification.{evaluatedCount,rejectedCount,insufficientInformationCount,expiredCount}`；`coarseRanking.{eligibleCount,belowThresholdCount,candidateLimitExcludedCount,deepMatchCandidateCount}`；`deepMatching.{evaluatedCount,qualityInsufficientCount,finalRecommendationCount}`；`suggestedActions` 为去重最多两个 `restart_discovery|review_source_health|review_profile|review_primary_target`。

验证闭包：qualification.evaluatedCount = discovery.discoveredJobCount；coarseRanking.eligibleCount = discoveredJobCount - rejectedCount - insufficientInformationCount - expiredCount = belowThresholdCount + candidateLimitExcludedCount + deepMatchCandidateCount；deepMatching.evaluatedCount = deepMatchCandidateCount = qualityInsufficientCount + finalRecommendationCount。可信结果必须 credibleBranchCount > 0。list 的 itemCount = finalRecommendationCount > 0 且 resultId = recommendationListId；no_recommendations 的 finalRecommendationCount = 0。来源计数按真实岗位机会去重，verifiedJobCount 与 discoveredJobCount 同口径。

Failure 复用稳定 AgentRunFailureCode 并补充 RECOMMENDATION_HANDOFF_FAILED / RECOMMENDATION_PUBLICATION_FAILED；失败建议动作另允许 run_model_diagnostic / review_account_run_policy。准备预算 discovery 取当前模式 effective fake/publicDiscovery，deepMatch 取 effective deepMatch。

**Files:**
- Create: `packages/contracts/src/recommendation-runs.ts`
- Modify: `packages/contracts/package.json`
- Test: `packages/contracts/src/recommendation-runs.test.ts`

**Interfaces:**
- Produces `RecommendationRunPreparationSchema`、`RecommendationRunSchema`、`RecommendationResultSchema`、`StartRecommendationRunCommandSchema` 与 `ControlRecommendationRunCommandSchema`。
- Consumers: Domain、API、Web BFF 和工作台组件。

- [ ] **Step 1: 写入失败的契约测试**

```ts
it("rejects an empty recommendation list result and non-closing evidence", () => {
  expect(() => RecommendationResultSchema.parse({
    kind: "recommendation_list", resultId, recommendationListId, itemCount: 0,
    evidence: nonClosingEvidence, publishedAt,
  })).toThrow();
});
```

该测试应在缺少 schema 时失败，保护的生产错误是“将空清单或不闭合计数发布为可信推荐结果”。另写测试验证固定五阶段顺序、最多两个建议动作、`no_recommendations` 没有清单 ID，以及命令严格拒绝目标/预算等越权字段。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter @job-copilot/contracts test -- recommendation-runs.test.ts`

Expected: FAIL，原因是模块或导出尚不存在。

- [ ] **Step 3: 实现最小 Zod 联合**

```ts
export const RecommendationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recommendation_list"), resultId: z.uuid(), recommendationListId: z.uuid(), itemCount: z.int().min(1), evidence: RecommendationResultEvidenceSchema, publishedAt: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal("no_recommendations"), resultId: z.uuid(), evidence: RecommendationResultEvidenceSchema, publishedAt: z.iso.datetime() }).strict(),
]);
```

实现中把发现、资格、粗排和深度匹配的计数闭包写进 `superRefine`，并将公共导出加入 package exports。

- [ ] **Step 4: 运行 GREEN 测试与类型检查**

Run: `pnpm --filter @job-copilot/contracts test -- recommendation-runs.test.ts && pnpm --filter @job-copilot/contracts typecheck`

Expected: PASS，且无 TypeScript 错误。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/contracts/package.json packages/contracts/src/recommendation-runs.ts packages/contracts/src/recommendation-runs.test.ts
git commit -m "feat: define recommendation run contracts"
```

### Task 2: 迁移持久化约束和幂等事实

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- `agent_runs` 新增 nullable `parent_run_id`、非空 `run_purpose` 和 nullable 私有 `recommendation_context`。`run_purpose` 固定为 `job_discovery | opportunity_reevaluation | recommendation`；`recommendation_context` 只允许存在于 `purpose = recommendation` 且 `parent_run_id IS NULL` 的根运行，推荐子运行和所有 legacy 运行必须为 null。JSON 固定为 `recommendation-context-v1`，包含 `profile.{profileId,profileVersion}`、`budgets.{discovery,deepMatch}`、`preflight` 与 `accountPolicyRevisionNumber`；数据库只校验对象、版本/必要键和字节上限，完整结构在写入前由契约 schema 校验。不要放宽或复用旧 `profile_snapshot` 的严格 workflow 语义。
- 迁移先以 nullable/default-free 方式加列并完成可靠历史映射，再设置 `run_purpose NOT NULL DEFAULT 'job_discovery'`。只把 `workflow = 'deep-match-v1' AND source_scope->>'trigger' = 'manual'` 的历史行标为 `opportunity_reevaluation`；其余历史行标为 `job_discovery`。不得根据历史 `discoveryRunId` 强制回填 `parent_run_id`，因为旧快照不足以可靠证明父子关系；legacy automatic deep-match 继续允许 `purpose = job_discovery AND parent_run_id IS NULL`。迁移后所有新的手动重评写路径必须显式写 `opportunity_reevaluation`，所有新推荐根/子显式写 `recommendation`，普通发现/automatic child 显式写 `job_discovery`。
- 仅对 `recommendation` purpose 强制父子语义：根必须是 discovery workflow、无 parent 且有 context；子必须是 `deep-match-v1`、`source_scope.trigger = 'automatic'`、有 parent 且 context 为 null。父子必须同 owner/target/purpose，禁止 self-reference，每个根最多一个推荐子。owner/target/self/唯一性用复合 FK、CHECK 和部分唯一索引；父 workflow、子 workflow/trigger、同 purpose 这些跨行条件用本迁移内窄约束触发器验证。不要把这些新约束追溯套到 legacy `job_discovery` automatic runs。
- 新增 `recommendation_run_control_commands(user_id, root_run_id, command_id, physical_run_id, action, command_fingerprint, result_snapshot, created_at)`，唯一键固定为 `(user_id, root_run_id, command_id)`，并分别以 owner-bound 复合 FK 绑定 root 和 physical run。结果快照不可变，必须保留首次物理目标；同 command 在阶段切换后回放只返回原快照。同步扩充现有 `agent_run_control_commands_result_snapshot_check` 的 `currentStep` 白名单，加入 `select_candidates | assess_matches | create_recommendations`，否则逻辑控制转发到深度匹配子运行后无法持久化物理命令结果。
- `recommendation_results` 的 root、producer、target 都必须 owner-bound；producer 必须是该 root 的推荐 child，root 必须为 recommendation purpose。每个 root 恰好最多一个结果、每个 producer 最多一个结果；结果行与启动/控制事实均以拒绝 `UPDATE/DELETE` 的触发器或等价权限规则保持不可变。
- 为 `recommendation_lists` 增加 `(user_id,id,target_id)` 可引用唯一键。list 结果使用复合 FK 精确绑定同 owner/target 的清单，且 `id = recommendation_list_id`、`item_count > 0`；`no_recommendations` 必须 `recommendation_list_id IS NULL` 且 final count 为 0。普通 CHECK 不能证明清单非空，因此发布顺序固定为 list → items → result，并由结果插入约束触发器验证至少一项。
- `agent_inbox_items` 新增 nullable `recommendation_result_id` 和 owner-bound FK/唯一索引；新增安全结果引用组合（建议 kind `recommendation_result`、reason `NO_RECOMMENDATIONS_PUBLISHED`），使可信空结果可直接指向 result，禁止用空 list 冒充。更新现有 kind/reason/reference CHECK，使 list item 仍只引用 list，result item 只引用 result，其他引用列必须为空。
- RED 迁移测试必须直接覆盖：manual 历史映射、legacy automatic 保持无 parent、所有新写显式 purpose、推荐 root context 必填/子 context 禁止、跨账户/跨目标/错误 workflow/trigger/purpose parent 拒绝、第二 child/result 拒绝、producer 不是 child 拒绝、空 list result 拒绝、no-result Inbox 合法引用、JSON 非对象/超限拒绝、启动/控制/result 更新删除拒绝，以及深度匹配 `currentStep` 可写入现有物理控制快照。
- 本任务文件范围还包括 `packages/database/migrations/meta/_journal.json`，以及仓库迁移生成流程实际产生的 snapshot（若有）。本任务已完成；账户停止的独立控制字段与幂等事实由新增 Task 11 的 0050 迁移实现，不回写本任务 0049。

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/migrations/0049_recommendation_runs.sql`
- Create: `packages/database/src/recommendation-runs.migrate.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RecommendationResult` 语义。
- Produces: `agentRuns.runPurpose`、`agentRuns.parentRunId`、`agentRuns.recommendationContext`、`recommendationRunStartCommands`、`recommendationRunControlCommands`、`recommendationResults` 和 `agentInboxItems.recommendationResultId`。

- [ ] **Step 1: 写入迁移集成 RED 测试**

```ts
it("allows exactly one automatic deep-match child and one result per recommendation root", async () => {
  await insertRecommendationRoot();
  await insertAutomaticChild();
  await expect(insertAutomaticChild()).rejects.toThrow(/unique|constraint/i);
  await insertRecommendationResult();
  await expect(insertRecommendationResult()).rejects.toThrow(/unique|constraint/i);
});
```

另测同一 `user_id + idempotency_key` 的同命令回放、跨账户/跨目标 parent FK、根运行必须为发现 workflow、手动深度匹配不得成为推荐子运行，以及 `no_recommendations` 不允许绑定清单。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter @job-copilot/database test -- recommendation-runs.migrate.integration.test.ts`

Expected: FAIL，迁移尚未创建相应表/约束。

- [ ] **Step 3: 写入最小迁移与 Drizzle schema**

```sql
alter table agent_runs add column run_purpose varchar(32) not null default 'job_discovery';
alter table agent_runs add column parent_run_id uuid;
create unique index recommendation_results_owner_root_unique
  on recommendation_results (user_id, root_run_id);
```

用复合外键约束 owner/target 一致性；用部分唯一索引限制推荐根仅一个自动 `deep-match-v1` 子运行。`recommendation_results` 只保存有界脱敏 JSON evidence，并以约束区分非空清单与“暂无推荐”。同步更新 schema 声明与 migration journal。

- [ ] **Step 4: 运行 GREEN 测试**

Run: `pnpm --filter @job-copilot/database test -- recommendation-runs.migrate.integration.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/database/src/schema.ts packages/database/migrations
git commit -m "feat: persist recommendation run identity and results"
```

### Task 3: 扩展运行前检查与准备摘要

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- Task 1 已扩展 `RunPreflightWorkflowSchema`；本任务只实现 recommendation evaluator，不再重复修改 enum。保留 `RunPreflightReportSchema.items.max(7)`：账户策略仍只生成一个 `ACCOUNT_RUN_POLICY_*` item，但该 item 必须同时验证 discovery 与 deep-match 两段 effective budget。
- preparation 支持全部当前 `JobDiscoveryExecutionMode`：`fake | greenhouse | layered_public`（设计中的 layered）。discovery budget 在 fake 模式取 `budgets.fake`，greenhouse/layered_public 取 `budgets.publicDiscovery`；deep-match 始终取 `budgets.deepMatch`。测试必须参数化三种模式，不能只覆盖 layered_public。
- 固定内部 seam：`prepareRecommendationRunInTransaction(tx, { userId, executionMode })` 返回 `{ preparation, startSpec, recommendationContext }`。`preparation` 是 Task 1 的安全公开投影；`startSpec` 含服务端解析的 targetId、workflow/source scope 与运行输入；`recommendationContext` 使用 Task 2 的私有 v1 结构。Task 4 的 start 必须在账户锁事务内调用该 seam，不能复算 target、profile、来源、预算或 preflight。
- helper 必须解析 active primary target、对应 profile ID/version、当前 watchlist/真实来源计划、当前 policy revision、两段 effective budget 与一次 recommendation preflight。没有 primary target 时返回 `target: null` 的 blocked preparation，私有 startSpec/context 为 null；公开 preparation 不泄漏 profile ID/version 或原始来源配置。
- `plannedTrustedSourceCount` 与 `plannedPublicQueryCount` 来自应用 limit 后真正会执行的冻结 source/query plan，不得用 policy 上限冒充。warning/blocked 都来自同一次 evaluator；Task 4 只允许 `ready` 或 warning fingerprint 完全匹配时启动。
- 将现有 discovery 启动所依赖的 spec 构造提取成可在事务内复用的窄 helper，并让普通 `createAgentRunStarter` 继续调用它；不要复制 private `layeredPublicDiscoverySpec`。因此本任务 Files 还包括 `packages/domain/src/agent-runs.ts` 及其现有集成测试，验证提取前后 fake/greenhouse/layered_public 行为不变。
- 消费 Task 12 当前账户停止判断，合入唯一 ACCOUNT_RUN_POLICY_BLOCKED 项并保留 max(7)。三种模式都测试：prepare 之后 stop，再 start 不创建 run；旧冻结 preflight 不授权继续。账户状态修复链接固定为已有 `/profile/run-policy`，公开 preparation 不新增敏感字段。

**Files:**
- Modify: `packages/contracts/src/run-preflight.ts`
- Modify: `packages/domain/src/run-preflight.ts`
- Create: `packages/domain/src/recommendation-runs-preparation.ts`
- Test: `packages/domain/src/recommendation-runs-preparation.test.ts`

**Interfaces:**
- Produces `prepare({ userId })`，包含活动主求职目标、可信来源/公开查询范围、账户策略修订、发现与深度匹配预算、当前报告。
- Consumes: `RunPreflightEvaluator`、账户运行策略和活动主求职目标。

- [ ] **Step 1: 写入 RED 测试**

```ts
it("blocks recommendation preparation when either discovery or deep-match budget is unavailable", async () => {
  const preparation = await queries.prepare({ userId });
  expect(preparation.preflight.status).toBe("blocked");
  expect(preparation.preflight.items.map((item) => item.code)).toContain("ACCOUNT_RUN_POLICY_BLOCKED");
});
```

同时覆盖准备摘要只返回服务端计算值、来源部分退化为 warning、错误主目标与模型诊断不能启动。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter @job-copilot/domain test -- recommendation-runs-preparation.test.ts`

Expected: FAIL，`recommendation` workflow 和准备查询尚不存在。

- [ ] **Step 3: 实现最小 evaluator 分支和准备投影**

将 `RunPreflightInput.workflow` 扩为 `"recommendation"`；对该工作流同时调用发现和深度匹配预算可用性判断，且固定解析活动 primary target。准备投影读取同一 evaluator 结果，绝不接受浏览器提供的 target 或预算。

- [ ] **Step 4: 运行 GREEN 测试**

Run: `pnpm --filter @job-copilot/domain test -- recommendation-runs-preparation.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/contracts/src/run-preflight.ts packages/domain/src/run-preflight.ts packages/domain/src/recommendation-runs-preparation.ts packages/domain/src/recommendation-runs-preparation.test.ts
git commit -m "feat: prepare recommendation run prerequisites"
```

### Task 4: 实现启动、查询、控制与阶段投影领域边界

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- 复用 Task 11 `applyAgentRunControlInTransaction`，不再次提取第二套 physical control seam。start 在幂等事实查询后、活动 root 复用/新建前读当前账户状态；resume 在命令 replay 后检查 stopped，pause/cancel 可执行。stop 后新 key 不复用活跃 root 来绕过阻断；旧 key 仅返回原事实。release 后旧 root/child 的 pause_requested/paused 不自动变化，逻辑层仅派生并允许用户逐个继续。
- 将 `packages/domain/src/agent-runs.ts` 与 `packages/domain/src/recommendation-runs.integration.test.ts` 加入 Files。先从现有 `createAgentRunStarter` 提取 transaction-bound run/steps/events/audit 插入 seam；推荐 start 不得调用会自行开启事务的 starter，也不得复制其写逻辑。
- `createRecommendationRunCommands({ db, queue, auditTrail, preflight, executionMode, id, clock })` 的 `start` 顺序固定为：账户 advisory lock → 按 `(user, idempotencyKey)` 读取旧命令并比较 fingerprint → 调 Task 3 transaction-bound prepare → 查询活动 recommendation root → 写 root（显式 purpose、context）、steps/events/audit 与 start command/alias。事务提交后立即 best-effort enqueue 根运行；失败由既有 reconciler 恢复。
- 同键同义不重复执行，返回原 root 的最新逻辑投影并标记 `reused: true`；同键异义稳定 409。不新增首次完整响应快照（2026-09-13 用户确认）。不同键只在没有既有 command 时复用同账户活动 root 并写 alias。活动定义为 `purpose = recommendation`、尚无 immutable result，且 root 或唯一 child 仍为 queued/running/paused；failed/cancelled 或已有结果后允许新 root。
- `latest({userId})` 只选 recommendation root，按 `created_at DESC, id DESC` 稳定排序；`get({userId,runId})` 同时校验 owner、root、purpose，不能把任意 physical run 投影成 logical run。投影权威事实依次为 root steps/status、root-scoped qualification/selection facts、child steps/status、immutable result；不得另写一套可漂移的五阶段状态。
- `control` 在同一账户锁事务内先读 Task 2 逻辑命令事实。若已存在，比较 fingerprint，按记录的 physical_run_id 读取首次物理命令的 applied 事实，不再次施加控制，返回原 logical root 的最新投影；若不存在，确定当前 physical root/child，调用 transaction-bound physical control seam并记录 `physical_run_id` 和首次物理快照。跨阶段 replay 不得重新作用于 child；物理阶段恰好切换且无法满足命令时返回稳定 409 并要求客户端刷新 authoritative projection。Task 2 不可变快照保留首次作用证据，不作为最新逻辑状态返回；此处覆盖 Task 2 旧文字“回放只返回原快照”的应用层解释，不改已完成迁移、不新增完整逻辑响应快照（2026-09-13 用户确认）。
- 账户隔离、不同键并发复用、同键异义、start commit/enqueue 恢复、root→child 控制竞争必须放在真实 PostgreSQL `recommendation-runs.integration.test.ts`；纯 `.test.ts` 只覆盖五阶段映射和稳定错误映射。`packages/domain/package.json` 导出 `./recommendation-runs`。

**Files:**
- Create: `packages/domain/src/recommendation-runs.ts`
- Test: `packages/domain/src/recommendation-runs.test.ts`
- Modify: `packages/domain/package.json`
- Modify: `packages/domain/src/agent-run-control.ts`

**Interfaces:**
- Produces `createRecommendationRunQueries()` 与 `createRecommendationRunCommands()`。
- Consumes: Tasks 1–3、账户 advisory lock、既有 `AgentRunStarter`/控制命令。

- [ ] **Step 1: 写入 RED 行为测试**

```ts
it("reuses one active logical run for concurrent different start keys", async () => {
  const [first, second] = await Promise.all([commands.start(startOne), commands.start(startTwo)]);
  expect(new Set([first.run.runId, second.run.runId])).toEqual(new Set([first.run.runId]));
  expect([first.reused, second.reused]).toContain(true);
});
```

再测同键异义冲突、终态后允许新命令、控制命令重放、根/子切换竞争 409、历史运行只可由 owner 读取、五阶段由持久化事实派生而非写第二套状态。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter @job-copilot/domain test -- recommendation-runs.test.ts`

Expected: FAIL，领域边界尚不存在。

- [ ] **Step 3: 实现账户锁内命令和投影**

```ts
await acquireAccountAdvisoryLock(tx, input.userId);
const active = await findActiveRecommendationRoot(tx, input.userId);
if (active) return recordAliasAndProject(tx, input, active);
const root = await startDiscoveryWithPurpose(tx, { ...input, runPurpose: "recommendation" });
return recordStartCommandAndProject(tx, input, root);
```

`get`/`latest` 在 SQL 读取后按根、子和结果派生 discovery → qualification → coarse_ranking → deep_matching → result_publication。控制只转发到当前活动物理运行，并以 `(user_id, root_run_id, command_id)` 记录目标运行，避免切换后重放控制另一条运行。

- [ ] **Step 4: 运行 GREEN 测试**

Run: `pnpm --filter @job-copilot/domain test -- recommendation-runs.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/domain/package.json packages/domain/src/recommendation-runs.ts packages/domain/src/recommendation-runs.test.ts packages/domain/src/agent-run-control.ts
git commit -m "feat: orchestrate logical recommendation runs"
```

### Task 5: 在发现完成事务中冻结本次候选并创建子运行

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- Files 必须改为真实边界：修改 `agent-run-processor.ts`、`deep-match-agent-runs.ts`、`deep-match-persistence.ts`、`job-triage-persistence.ts`，并在需要统一非 layered 结果查询时修改 `job-discovery-persistence.ts`；测试使用 `agent-run-processor.integration.test.ts`、`deep-match-persistence.integration.test.ts`、`deep-match-trigger.test.ts`、`job-triage-persistence.integration.test.ts`，必要时补 `job-discovery-persistence.integration.test.ts`。不要创建与现有 fixture 脱节的同名单元测试。
- 定义一个 root-scoped discovery-result adapter，输出 `{ opportunityId, sourcePostingVersionId }[]`：fake/greenhouse 从该 root 的 `agent_run_job_results` 读取，layered_public 从该 root 的 `job_discovery_run_results` 读取并 owner-bound 关联 opportunity。三种模式都必须以 rootRunId + userId + targetId 限定并稳定去重；测试同时插入同 target 历史运行结果，证明不会泄漏。
- 推荐 handoff 从 root 的 `recommendation_context` 读取冻结 profile ID/version、预算、preflight/policy 依据，并使用 root row 的 targetId；不得在发现完成时改读当前 profile。为此抽取 transaction-bound triage create/reuse seam，显式接收 `profileId/profileVersion` 与本 root 的 posting version IDs，历史 facts 查询同样限制 profile version。
- 候选选择只读取上一步本 root triage，写入冻结 selection/exclusions 后调用 `ensureDeepMatchRunInTransaction`。推荐 child 显式写 `parentRunId: root.id`、`runPurpose: recommendation`，并继承 context 中 deep-match budget、preflight 和 policy revision，跳过第二次 preflight；child 自身不复制 `recommendation_context`。
- 普通手动/计划发现和既有 automatic matching 保持原行为与当前 preflight，不要求 parent，也不能因新增 purpose 分支而被切断。为 fake/greenhouse/layered_public 各加一条 recommendation handoff 集成用例，并保留 legacy discovery 回归。
- handoff 仍位于各模式完成根运行的同一 fenced transaction：先持久化 root results/triage/selection，后 durable child，最后完成 root；只在提交后 enqueue child。空候选也创建 initialized child，供 Task 6 在可信来源证据成立时发布 no-recommendations。
- 推荐 child 消费 Task 12 的实时停止守卫；跳过第二次 preflight 不跳过账户 admission、pause/cancel、预算、claim/lease/hard-limit。handoff 在持有账户锁的完成事务内先读 control，停止先提交则不能写 root 终态/child/候选发布；handoff 先提交则 stop 必须看见并暂停其 queued/running child。三种模式分别覆盖两种锁顺序，release 不自动排 child。

**Files:**
- Modify: `packages/domain/src/agent-run-processor.ts`
- Modify: `packages/domain/src/deep-match-agent-runs.ts`
- Test: `packages/domain/src/agent-run-processor.test.ts`
- Test: `packages/domain/src/deep-match-agent-runs.test.ts`

**Interfaces:**
- Consumes: 推荐根运行与发现结果。
- Produces: 一次性资格门槛/粗排快照和唯一自动深度匹配子运行；非推荐的发现运行保持兼容。

- [ ] **Step 1: 写入 RED 测试**

```ts
it("uses only postings persisted by the completing recommendation root", async () => {
  await persistAnOlderPostingForTarget();
  await completeRecommendationDiscovery(rootRunId);
  expect(await candidatesFor(rootRunId)).toEqual([expect.objectContaining({ sourceRunId: rootRunId })]);
});
```

另测根运行完成前 handoff 失败会失败而非完成、空候选仍创建可发布子运行、queue enqueue 失败由 reconciler 恢复、恢复处理不创建第二个子运行。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter @job-copilot/domain test -- agent-run-processor.test.ts deep-match-agent-runs.test.ts`

Expected: FAIL，历史岗位仍可能参与或缺少父子关联。

- [ ] **Step 3: 最小化改造完成事务**

仅对 `runPurpose === "recommendation"` 的发现根，在 `persistLayeredPublicOutcome` 的同一 fenced transaction 中：写发现结果 → 只查该 root 的 posting versions → 写 triage/粗排/排除快照 → 调用 `ensureDeepMatchRunInTransaction({ parentRunId: rootId, inheritedPreflight: root.preflightSnapshot })` → 终结根运行。自动子运行跳过会阻断继承快照的第二次 preflight，但仍经过全局停止、预算、暂停、取消和 claim 安全检查点。

- [ ] **Step 4: 运行 GREEN 测试**

Run: `pnpm --filter @job-copilot/domain test -- agent-run-processor.test.ts deep-match-agent-runs.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/domain/src/agent-run-processor.ts packages/domain/src/deep-match-agent-runs.ts packages/domain/src/agent-run-processor.test.ts packages/domain/src/deep-match-agent-runs.test.ts
git commit -m "feat: hand off recommendation discovery to deep matching"
```

### Task 6: 原子发布推荐结果、可信空结果与 Inbox

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- Task 12 的账户发布守卫必须保留在 publishStagedRun 同一账户锁事务内，推荐 result/list/Inbox/journey 的首个写入之前；两类结果都覆盖 stop 先提交→无新发布、publish 先提交→历史结果保留。不得在本切片改成只读冻结 context 或只查 child.controlState；迟到 settleActual 只结算，不触发 publication。
- 真实原子发布 seam 是 `packages/domain/src/deep-match-persistence.ts::publishStagedRun`。Files 至少加入该文件、`packages/contracts/src/agent-inbox.ts`、`packages/domain/src/agent-inbox.ts` 和必要的 Web Inbox 投影/组件；测试固定使用 `deep-match-persistence.integration.test.ts`、`agent-run-processor.integration.test.ts`、`first-recommendation-journey.integration.test.ts`、`agent-inbox.integration.test.ts`、`agent-inbox.test.ts`，必要时更新 `agent-inbox-panel.test.tsx`。
- `publishStagedRun` 先完成全部 staging/fence 校验并计算 accepted，再分支。accepted 非空时按 list → items/exclusions → `recommendation_results` 写入，result ID 与 list ID 相同且 itemCount 等于实际 items；accepted 为空时完全不创建 list/items，只创建独立 `no_recommendations` result。
- evidence 必须从 parent root 的模式无关 result adapter、冻结 source diagnostics/issues、root-scoped triage/selection 与 child staging 计算，经 Task 1 schema 验证后才入库。`credibleBranchCount = 0`、staging 未闭合、run 非 recommendation child、claim/control/lease/budget fence 失效或 parent 失败时一律不得发布可信空结果。
- result、对应 Inbox、`recordFirstRecommendationJourneyCompletion`、child terminal status/event/audit 必须处于 `publishStagedRun` 同一事务。唯一冲突 replay 要 owner-bound 读取现有 result 并验证同义；任何差异为 publication conflict，不能 `ON CONFLICT DO NOTHING` 后继续。
- list Inbox 继续安全引用 list；no-recommendations Inbox 使用 Task 2 新增的 `recommendation_result_id`，公共 `AgentInboxItem` 新增 `recommendation_result` target，只投影 result/root/target ID 和内部 href，不把完整 evidence 或上游正文塞入 Inbox。现有 `run_failed` 重启动作文案不可冒充空结果。
- `first-recommendation-journey.ts` 已支持 `no_recommendations`；除非 integration RED 证明缺行为，不修改该生产文件。重复投递测试逐一断言 match versions、list/items/exclusions、result、Inbox、journey completion、child terminal event 恰好一次，并断言没有简历、投递准备或外部行动记录。

**Files:**
- Modify: `packages/domain/src/agent-run-processor.ts`
- Modify: `packages/domain/src/first-recommendation-journey.ts`
- Test: `packages/domain/src/agent-run-processor.test.ts`
- Test: `packages/domain/src/first-recommendation-journey.test.ts`

**Interfaces:**
- Produces: 每根运行唯一 `recommendation_results`、对应 Inbox 项、终态和首次推荐旅程完成事实。

- [ ] **Step 1: 写入 RED 测试**

```ts
it("publishes no_recommendations only after a credible successful discovery branch", async () => {
  await runDeepMatch({ rootRunId, allCandidatesRejected: true, successfulSourceCount: 1 });
  expect(await resultFor(rootRunId)).toMatchObject({ kind: "no_recommendations" });
  await expect(runDeepMatch({ rootRunId: failedRootRunId, successfulSourceCount: 0 })).rejects.toThrow();
});
```

另测部分来源失败仍保留覆盖损失、失败/取消/预算耗尽不发布空结果、重复 Worker 投递不重复 result/list/Inbox/journey，及发布后无简历或投递领域记录。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter @job-copilot/domain test -- agent-run-processor.test.ts first-recommendation-journey.test.ts`

Expected: FAIL，当前发布器没有不可变结果与可信空结果约束。

- [ ] **Step 3: 实现 fenced 原子发布**

在深度匹配 `create_recommendations` 的既有 claim transaction 内，先完成匹配版本与闭合证据，再按联合类型创建非空清单或 `no_recommendations` 结果；接着创建有限、原因匹配的 Inbox 项，调用 `recordFirstRecommendationJourneyCompletion`，最后终结子运行和写事件。任何一步异常均回滚。

- [ ] **Step 4: 运行 GREEN 测试**

Run: `pnpm --filter @job-copilot/domain test -- agent-run-processor.test.ts first-recommendation-journey.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add packages/domain/src/agent-run-processor.ts packages/domain/src/first-recommendation-journey.ts packages/domain/src/agent-run-processor.test.ts packages/domain/src/first-recommendation-journey.test.ts
git commit -m "feat: publish durable recommendation results"
```

### Task 7: 暴露认证 API 和同源 BFF

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- 复用 Task 13 安全错误映射模式，recommendation start/resume 的 ACCOUNT_RUN_STOPPED 返回 409；preflight blocked 仍返回最新报告。账户 control 两个路由已由 Task 13 交付，不复制到 RecommendationRuns module；所有读取在停止期间仍可用。
- endpoint 固定为 `GET /v1/recommendation-runs/preparation`、`POST /v1/recommendation-runs`、`GET /v1/recommendation-runs/latest`、`GET /v1/recommendation-runs/:runId`、`POST /v1/recommendation-runs/:runId/controls`；BFF 一一对应。原 Interfaces 中连写的 `preparation/latest/:runId` 和 `start/:runId/controls` 不是路由定义。
- RecommendationRuns module 必须按 Task 4 factory 的完整签名装配 db、queue、audit trail、preflight、execution mode、id、clock，并导入已有 Auth/AgentRuns/RunPreflight/runtime config 所需 provider。controller 只从 `SessionGuard` 身份注入 userId，body 严格限于契约字段。
- 五个 BFF route 均有相邻 `.test.ts`，API controller/module 各有启动测试；`apps/web/lib/server/api-client.test.ts` 加 preparation/start/latest/get/control schema 与状态映射。覆盖 201 首建、200 同义重放/活动复用、400 非法越权字段、401、owner-hidden 404、409 preflight/阶段冲突、`Cache-Control: no-store`，未知或畸形上游错误统一安全 502 且不反射正文。
- 为 Task 9 同步扩展既有 recommendation read seam：`RecommendationQueries.getList({ userId, targetId, recommendationListId })`，API 为 `GET /v1/recommendations/lists/:recommendationListId?targetId=...`，BFF 为 `GET /api/recommendations/lists/:recommendationListId?targetId=...`，server/api-client helper 精确按 ID 读取。复用现有 `deep-match-persistence.readList`，owner/target 不匹配返回同样 404；不得回退为 latest-by-target。
- 因此 Files 还包括 `packages/domain/src/recommendation-queries.ts`、`apps/api/src/recommendations/recommendations.controller.ts/.test.ts`、`apps/web/app/api/recommendations/lists/[recommendationListId]/route.ts/.test.ts` 与 `apps/web/lib/server/api-client.test.ts`。Task 7 GREEN 要串行运行 RecommendationRuns API、五个 BFF、exact-list API/BFF 和 api-client 的窄测试。

**Files:**
- Create: `apps/api/src/recommendation-runs/recommendation-runs.controller.ts`
- Create: `apps/api/src/recommendation-runs/recommendation-runs.module.ts`
- Create: `apps/api/src/recommendation-runs/recommendation-runs.tokens.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/web/app/api/recommendation-runs/preparation/route.ts`
- Create: `apps/web/app/api/recommendation-runs/route.ts`
- Create: `apps/web/app/api/recommendation-runs/latest/route.ts`
- Create: `apps/web/app/api/recommendation-runs/[runId]/route.ts`
- Create: `apps/web/app/api/recommendation-runs/[runId]/controls/route.ts`
- Modify: `apps/web/lib/server/api-client.ts`
- Test: `apps/api/src/recommendation-runs/recommendation-runs.controller.test.ts`
- Test: `apps/web/app/api/recommendation-runs/route.test.ts`

**Interfaces:**
- Produces `GET preparation/latest/:runId`、`POST start/:runId/controls` 及 BFF 同源映射。

- [ ] **Step 1: 写入 RED API/BFF 测试**

```ts
it("does not allow a browser to select another target when starting", async () => {
  const response = await request.post("/v1/recommendation-runs").send({
    idempotencyKey, warningFingerprint: null, targetId: anotherTargetId,
  });
  expect(response.status).toBe(400);
});
```

覆盖 201 首建、200 幂等复用、409 过期运行前检查/控制冲突、账户隐藏 404、未认证 401、BFF `no-store` 和上游错误正文不泄露。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter api test -- recommendation-runs.controller.test.ts && pnpm --filter web test -- api/recommendation-runs/route.test.ts`

Expected: FAIL，路由和 providers 尚不存在。

- [ ] **Step 3: 实现最小 REST/BFF 边界**

API controller 从 `SessionGuard` 的账户身份构造命令输入；严格 DTO 只接受 idempotency key、warning fingerprint 和 control command。BFF 套用现有 agent-runs 路由的 session 转发/状态白名单模式，并在 API client 添加对应调用。

- [ ] **Step 4: 运行 GREEN 测试**

Run: `pnpm --filter api test -- recommendation-runs.controller.test.ts && pnpm --filter web test -- api/recommendation-runs/route.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add apps/api/src/recommendation-runs apps/api/src/app.module.ts apps/web/app/api/recommendation-runs apps/web/lib/server/api-client.ts
git commit -m "feat: expose recommendation run endpoints"
```

### Task 8: 在工作台提供启动、恢复、控制和可访问状态面板

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- 当前 preflight 为账户停止时禁用 start，并指向 `/profile/run-policy`；resume 被 ACCOUNT_RUN_STOPPED 拒绝时刷新权威状态并显示同一修复入口。不要在工作台新增“恢复所有”或自动调用 resume；release 后用户通过现有逐运行继续操作恢复，未恢复的 paused 状态保持可见。覆盖旧运行入口和新逻辑面板。
- Files 还包括 `apps/web/lib/server/recommendation-runs.test.ts`、`apps/web/app/(workbench)/home/page.test.tsx`、`apps/web/components/workbench/workbench-home-view.test.tsx`、`apps/web/components/workbench/agent-run-panel.tsx/.test.tsx`。先固定 `WorkbenchHomeView` 新 props 与 unavailable 状态，再接面板。
- `home/page.tsx` 默认并行读取 preparation + latest recommendation run；显式 `runId` 先调用 owner-bound logical `getRecommendationRun`。只有收到 logical 404 时才用现有 `getAgentRun` 兼容历史 physical-run 深链，其他错误不得吞掉或降级为另一种资源。
- 不能直接移除 `AgentRunPanel`，因为它承载 `DiscoverySchedulePanel`。最小接线是在旧 panel 增加 `showStartControls={false}`（或等价窄 prop）以保留 schedule/history/旧物理运行展示，由新 `RecommendationRunPanel` 唯一承接“一键发现”启动和逻辑控制。
- 新面板 start 后以服务端返回的 logical runId 为唯一轮询键；只在 document visible 且非 terminal 时轮询，visibility 恢复立即 fetch，terminal/unmount 清 timer。201、200、409 都重新采用 authoritative projection；409 不在客户端猜状态。
- Inbox 更新若命中当前逻辑 root 或 child，必须触发 logical run refetch/`router.refresh()`，不能只递增旧 AgentRunPanel 的 refreshVersion。保持键盘顺序、`aria-current`、非抢焦点 `aria-live` 和至少 44px 操作目标。
- server helper 测试覆盖无 session、owner-hidden 404 与非 404 透传；页面/组件测试覆盖 SSR 恢复、旧链接 fallback、schedule 保留、warning 确认、blocked target-null、轮询清理、控制重放和 Inbox 刷新。不得把测试限定为 layered_public；UI 消费统一逻辑投影，不识别底层 mode。

**Files:**
- Create: `apps/web/lib/server/recommendation-runs.ts`
- Create: `apps/web/components/workbench/recommendation-run-panel.tsx`
- Create: `apps/web/components/workbench/recommendation-run-panel.test.tsx`
- Modify: `apps/web/app/(workbench)/home/page.tsx`
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: Task 7 BFF 和 Task 1 契约。
- Produces: “开始今日发现”、启动摘要、明确警告确认、五阶段有序列表、暂停/继续/取消、仅在可见非终态页面轮询。

- [ ] **Step 1: 写入 RED 组件测试**

```tsx
it("stops polling when the document is hidden and resumes it for an active run", async () => {
  render(<RecommendationRunPanel initialRun={runningRun} initialPreparation={preparation} />);
  await expect.poll(fetchSpy).toHaveBeenCalled();
  setDocumentVisibility("hidden");
  vi.advanceTimersByTime(15_000);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
```

再测阻塞禁用、warning 确认、阶段文案/`aria-current`、不抢焦点的 `aria-live`、44px 交互目标和服务端状态恢复。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter web test -- recommendation-run-panel.test.tsx`

Expected: FAIL，组件尚不存在。

- [ ] **Step 3: 最小实现并接入首页**

新面板替换首页直接暴露的 `AgentRunPanel` 启动职责，但保留历史物理运行页兼容。以 `<ol>` 展示固定阶段；显示 “开始今日发现”、摘要和结果导向中文。轮询通过 `/api/recommendation-runs/:runId`，仅页面可见且 `status` 非终态时工作，返回数据不改写用户焦点。

- [ ] **Step 4: 运行 GREEN 测试与 lint**

Run: `pnpm --filter web test -- recommendation-run-panel.test.tsx && pnpm --filter web lint`

Expected: PASS，且无 lint 错误。

- [ ] **Step 5: 提交本任务**

```bash
git add apps/web/lib/server/recommendation-runs.ts apps/web/components/workbench/recommendation-run-panel.tsx apps/web/components/workbench/recommendation-run-panel.test.tsx 'apps/web/app/(workbench)/home/page.tsx' apps/web/components/workbench/workbench-home-view.tsx apps/web/app/globals.css
git commit -m "feat: manage recommendation runs from workbench"
```

### Task 9: 在推荐页呈现结果与覆盖证据

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- 停止期间保留历史推荐结果读取，暂停/停止不能显示为可信“暂无推荐”；manual reevaluation 接 Task 13 安全 409 并引导账户策略页，release 不主动重评。增加停止前已发布结果在停止/解除后仍绑定同 result/list 的视图断言。
- Files 还包括 `apps/web/app/(workbench)/recommendations/page.test.tsx`、`apps/web/lib/server/recommendations.ts` 及对应测试（若仓库尚无该文件则创建 `recommendations.test.ts`）。页面先读取 latest immutable recommendation result；结果自带非空 target，不能继续选择“第一个 active target”。尚无 result 时才以 active primary target 维持既有准备/历史入口。
- `recommendation_list` 分支必须调用 Task 7 exact helper，以 `{ targetId: result.target.targetId, recommendationListId: result.recommendationListId }` 精确取 list；404 是结果一致性错误，不得静默改读 target 最新 list。manual reevaluation 或后续新 list 不得替换逻辑运行绑定的清单。
- `no_recommendations`、尚无 result、失败/取消是三个不同视图：可信空结果展示已检查来源、资格/粗排/深匹配闭合计数、coverage losses 和最多两个服务端动作；尚无结果保留准备提示；失败/取消由逻辑运行投影给稳定原因，不渲染为空结果。
- 既有 recommendation history、manual reevaluation、decision、calibration 和 exclusions 仍使用原接口/语义；新 summary 只包裹 logical result。测试须证明 secondary target 排序变化不影响绑定结果、exact list 不是 latest list、空结果不造空 `<ol>`、覆盖损失有界且不显示上游/模型原文。

**Files:**
- Modify: `apps/web/app/(workbench)/recommendations/page.tsx`
- Create: `apps/web/app/(workbench)/recommendations/recommendation-result-summary.tsx`
- Create: `apps/web/app/(workbench)/recommendations/recommendation-result-summary.test.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: 最新 `RecommendationResult`；有清单时继续用既有列表读取。
- Produces: 推荐清单覆盖摘要，或可解释的“暂无推荐”证据/建议动作。

- [ ] **Step 1: 写入 RED 视图测试**

```tsx
it("explains a credible empty result without rendering a fake empty list", () => {
  render(<RecommendationResultSummary result={noRecommendationsResult} />);
  expect(screen.getByRole("heading", { name: "今天暂无推荐" })).toBeVisible();
  expect(screen.queryByRole("list", { name: "推荐岗位" })).not.toBeInTheDocument();
  expect(screen.getByText("已检查 3 个来源")).toBeVisible();
});
```

再测部分成功覆盖损失、有限建议动作和历史/手动单岗位重新评估的既有视图不变。

- [ ] **Step 2: 运行 RED 测试**

Run: `pnpm --filter web test -- recommendation-result-summary.test.tsx`

Expected: FAIL，结果联合视图尚不存在。

- [ ] **Step 3: 实现结果联合分支**

`recommendation_list` 复用当前清单内容并附“覆盖情况”摘要；`no_recommendations` 只显示来源覆盖、资格淘汰、信息不足、降级和最多两个服务端建议动作。不得以空数组、模型原文或技术原因代替结果。

- [ ] **Step 4: 运行 GREEN 测试**

Run: `pnpm --filter web test -- recommendation-result-summary.test.tsx`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add 'apps/web/app/(workbench)/recommendations/page.tsx' 'apps/web/app/(workbench)/recommendations/recommendation-result-summary.tsx' 'apps/web/app/(workbench)/recommendations/recommendation-result-summary.test.tsx' apps/web/app/globals.css
git commit -m "feat: explain recommendation run results"
```

### Task 10: 端到端验收和回归验证

**执行修正（2026-09-12，优先于本任务后续旧草图）：**

- 五个原验收场景之外，增加账户策略页停止→工作台 blocked→旧运行暂停→解除→旧运行仍暂停→用户逐个继续的浏览器场景；历史结果始终可读。Task 12 的 PG 测试负责在途结算、双向发布竞争、离线 claim 收敛和离线定时 cutoff，不用浏览器计时模拟数据库竞态。最终完整日志必须包括 Task 11–13 与 Task 3–10，才能声称全局停止已验收。
- 不使用未定义的 `countRecommendationResults()`：按仓库现有 E2E setup 用 `pg.Client` 建立本 spec 内 owner-bound helper，查询 recommendation root、其唯一 child、result、可选 list/items、Inbox/journey，以及简历/投递/外部行动副作用计数；每个 helper 参数显式包含 userId 和 rootRunId。
- 浏览器同一按钮双击不作为并发证明。Task 4 integration test 负责数据库并发；E2E 用两个直接 API POST 制造同键重放和不同键并发（携带同一已登录 session），再由页面恢复返回的唯一 logical run。这样不会因第一次点击禁用按钮使第二个 Playwright click 超时。
- 五个场景使用现有按 user/target 限定的 fake/PG trigger fixture：有推荐、可信空结果、部分来源失败、离页恢复、重复启动。fixture 必须在 `beforeEach/afterEach` 安装与清理，等待条件用数据库权威事实或可见终态；同时保留 fake、greenhouse、layered_public 的 domain integration 覆盖，不要求 E2E 为每个 mode 复制五组场景。
- “无外部行动”同时断言相关业务表无新增，并由已有 fake adapter/audit 证明未调用页面填写、提交、邮件或联系路径；只查 UI 文案不够。E2E 不新增生产测试 API。
- Task 10 的 `git add` 必须覆盖本任务实际修改的 `one-click-recommendation.spec.ts`、可选 first-journey spec、README 和 support fixture 文件。全量 `pnpm test → typecheck → lint → build → test:e2e` 严格串行，并遵守 Supervisor/Executor 不重叠测试；仅凭完整新鲜日志逐条验收后才评论/关闭 Issue。

**Files:**
- Create: `apps/web/e2e/one-click-recommendation.spec.ts`
- Modify: `apps/web/e2e/first-recommendation-journey.spec.ts`（仅在新结果联合需更新既有断言时）
- Modify: `README.md`（仅新增本地验收所需的 fixture 启动说明时）

**Interfaces:**
- Consumes: 全部已交付行为和可控 fake fixture。
- Produces: Issue #53 指定的五个浏览器验收场景。

- [ ] **Step 1: 写入第一个 RED Playwright 场景**

```ts
test("duplicate starts create one logical run and one recommendation result", async ({ page }) => {
  await page.goto("/home");
  await Promise.all([page.getByRole("button", { name: "开始今日发现" }).click(), page.getByRole("button", { name: "开始今日发现" }).click()]);
  await expect(page.getByText("推荐结果已准备好")).toBeVisible();
  await expect.poll(() => countRecommendationResults()).toBe(1);
});
```

其余场景分别覆盖有推荐、可信“暂无推荐”、部分来源失败仍交付、离页后返回恢复阶段；每个场景断言没有简历、投递准备包、投递执行或外部行动记录。

- [ ] **Step 2: 运行 RED 场景**

Run: `pnpm --filter web test:e2e -- one-click-recommendation.spec.ts`

Expected: FAIL，入口/投影尚未完整实现。

- [ ] **Step 3: 只修复验收揭示的实现缺口**

对失败断言逐一回到对应任务的领域、API 或组件 seam，先加窄回归单测，再写最小生产修复；不添加通用工作流、额外自动化或无关重构。

- [ ] **Step 4: 串行运行完整验证**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e`

Expected: 所有命令依次退出 0；任何失败先定位并修复，不能并行重跑同一或重叠测试。

- [ ] **Step 5: 提交本任务并更新 Issue**

```bash
git add apps/web/e2e/one-click-recommendation.spec.ts
git commit -m "test: cover one-click recommendation run"
gh issue comment 53 --body "$(git log -1 --format='已实现 #53（提交 %H）：已完成 pnpm test、pnpm typecheck、pnpm lint、pnpm build 与 pnpm test:e2e 的新鲜验证。')"
gh issue close 53
```

关闭前需以新鲜命令输出核验每条 acceptance criteria；若任何项不满足，不关闭 Issue。

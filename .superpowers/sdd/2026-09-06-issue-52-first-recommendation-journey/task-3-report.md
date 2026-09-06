# Task 3 实现报告：动态首次推荐旅程

## 实现范围

- 新增 `packages/domain/src/first-recommendation-journey.ts`，提供严格限定的三条领域接口：旅程读取、交互更新和可信完成事实记录。
- 读取以永久完成事实为最高优先级；仅在未完成时才结合职业资料导入、统一运行前检查和活动运行投影六步旅程。
- 交互状态按账户隔离，首次写入从版本 0 变为 1，后续更新带版本条件；账户不存在、陈旧版本和已完成旅程分别返回稳定领域错误。
- 完成记录采用账户主键 `ON CONFLICT DO NOTHING`，没有捕获或转换数据库错误。
- 工作台首页通过注入的旅程读取器并行读取并返回 `firstRecommendationJourney`；既有摘要计算没有改写。

## RED 证据

命令：

```text
pnpm --filter @job-copilot/domain exec vitest run src/first-recommendation-journey.integration.test.ts --no-file-parallelism
```

结果：失败。`Cannot find module './first-recommendation-journey'`，证明新的领域读取、交互与完成接口尚不存在。

随后在首页集成红测中运行：

```text
pnpm --filter @job-copilot/domain exec vitest run src/first-recommendation-journey.integration.test.ts src/workbench-home.integration.test.ts --no-file-parallelism
```

结果：失败。首页结果缺少 `firstRecommendationJourney`，证明首页尚未消费新投影。

## GREEN 与验证证据

```text
pnpm --filter @job-copilot/domain exec vitest run src/first-recommendation-journey.integration.test.ts src/workbench-home.integration.test.ts --no-file-parallelism
```

结果：2 个测试文件、10 个测试通过。

```text
pnpm --filter @job-copilot/domain typecheck
```

结果：通过（`tsc --noEmit`）。

```text
git diff --check
```

结果：通过，无空白错误。

## 自审

- `lastVisitedStep` 只有仍未完成时才可成为 `currentStepId`；已完成步骤会回退到第一个未完成步骤。
- 普通空清单、失败运行和未发布运行均不写完成事实；首份结果只有活跃运行时为进行中。
- 完成事实读取先于动态运行前检查，因此动态条件退化不会重新打开旅程。
- 所有查询和写入均按 `userId` 过滤；完成记录器没有 HTTP 或首页入口。
- 建议动作映射只覆盖运行前检查契约的六个站内白名单动作。

## Concerns

- Task 4 仍需在非空推荐发布事务内调用完成记录器；本 Task 刻意未接入该事务。
- Task 5 必须为 API 的 `createWorkbenchHome` 装配真实旅程读取器和运行前检查评估器；本 Task 只收紧领域构造函数并更新领域集成夹具。

# 首次推荐旅程最小指标（#57）

遵守 ADR 0039。指标只观察领域事实，不影响旅程页面、推荐发布、运行准入或交互状态。Worker 每 5 秒单进程不重叠采集；跨 Worker 通过数据库唯一键去重。离开页面、刷新、重新登录或换设备不会重新开始计时。后台停止期间可从登录审计、运行终止和不可变首次推荐完成事实补采。采集故障仅输出固定代码 `JOURNEY_METRIC_COLLECTION_FAILED`，不保存原始错误，也不计入用户的产品阻塞。

## 运营入口与分母

本项目尚无邀请管理系统。运营方使用受信任的服务端命令显式登记邀请账户；未登记的本地演示账户和普通账户不采集。运行命令需要部署环境的 `DATABASE_URL` 与原有运行配置。不要把数据库访问权或私有登记表分享给指标使用者。

```sh
pnpm metrics enroll <内部账户UUID> valid
pnpm metrics enroll <内部账户UUID> invalid
pnpm metrics report
pnpm metrics events
```

`valid` 表示运营方已核验该邀请用户**首次登录时**的部署级模型与岗位发现运行配置有效；`invalid` 表示不满足。该分类是邀请试用的运营记录，不是从用户是否已上传简历、设置目标或完成旅程倒推，也不授予运行权限。首次登录前可对已存在账户登记，事后补登必须依据当时的部署检查记录，不能用当前成功配置回填历史。登记后分类不可改变，重复同类登记幂等。命令不会保存密钥、诊断原文、供应商信息或邀请联系人信息。

开始时间来自账户最早的 `auth.session_started` 审计事实，不是登记、页面访问或首次采集时间。无登录事实的登记账户不进入分母。`eligibleJourneys` 为有效配置且已经登录的邀请账户数，`invalidConfigurationJourneys` 单列配置失效账户。每次登记生成独立随机 `journeyId`，私有映射只用于内部关联，事件导出没有内部账户 ID。

为避免观察窗口尚未结束带来的偏差，`evaluatedJourneys` 只包含首次登录已满 20 分钟的有效配置邀请账户，`pendingJourneys` 为尚在观察窗口内的账户。`completedWithin20Minutes / evaluatedJourneys` 是 `completionRate`（0–1），分母为零时返回 `null`；恰好 20 分钟完成算成功。早于 20 分钟完成的账户也要等窗口成熟后进入这组比率。`missed20MinuteTarget` 为未达20分钟目标的成熟账户数，包含晚完成和仍未完成的账户，不将超时本身推定为产品故障。核心门槛为该比率至少 0.8，且 `unknownBlockedJourneys = 0`。

## 事件与时间语义

固定版本 `first-recommendation-metrics-v1`。事件字段仅包含 `version`、随机 `journeyId`、散列去重键 `eventKey`、`type`、`stage`、`occurredAt`、`elapsedMs`、`terminalStatus`、`reasonCode`、`configuration`。Zod 严格白名单和数据库约束拒绝额外字段及任意原因文本。事件不会进入普通日志、错误跟踪或第三方埋点服务。

阶段复用权威旅程的六个 ID：职业资料 `career_materials`、可信画像 `profile_evidence`、主目标 `primary_target`、真实来源 `job_sources`、运行前检查 `run_readiness`、首个推荐结果 `first_result`。

- `started`：最早登录事实，`elapsedMs = 0`。
- `stage_reached`：首次观察到领域投影的该阶段已满足，时间为首次采集时间；阶段耗时可用相邻里程碑之差分析，但这是采样指标，通常存在最多一个扫描周期的误差，停机期间未持久化的瞬时状态不会被臆造补齐。
- `blocked`：当前运行前检查中的阻塞代码、缺失/失败职业资料，或无法归因的 `UNKNOWN_BLOCKER`。同一旅程每种原因首次出现记一次，供诊断历史覆盖，不代表当前仍被阻塞。等待、离开页面或正常运行超过 20 分钟不构成未知故障证据。
- `terminated`：关联推荐运行失败或取消，以运行事实中的实际终止时间计时，逐运行幂等。预算、模型鉴权、策略拒绝和主动取消使用已知固定代码；泛化适配器/持久化等失败归入未知原因。终止某次尝试不阻止用户重试，不构成旅程完成。
- `completed`：只读取发布器写入的不可变首次推荐完成事实，使用实际完成时间；`terminalStatus` 是 `recommendation_list` 或 `no_recommendations`。普通空数组、未发布结果与失败运行都不能完成。账户级唯一约束防止重试、恢复或并发重复计数；完成之后不再采集动态前置条件退化。

`knownBlockedJourneys` 和 `unknownBlockedJourneys` 统计成熟且有效配置邀请账户曾遇到的对应原因，两者可能重叠，成功账户也可有阻塞历史。未知阻塞不被已有的已知阻塞掩盖。通过事件中的固定原因可进一步分开用户准备事项与已知产品阻塞。阶段时间与原因均是观察历史，不能用于决定下一步业务动作。

私有登记表的关联仍意味着这些指标是脱敏数据，并非不可重新识别的匿名数据；产品团队只应获取 `report` 或 `events` 输出，不能获取登记映射表。

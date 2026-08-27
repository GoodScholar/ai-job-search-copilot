# Markdown 职业资料导入与候选事实设计

## 目标

交付 Issue #3 的完整产品纵切：已登录的目标求职者通过网站上传一份 Markdown 职业资料，原始文件进入 S3 兼容对象存储，独立 Worker 通过 BullMQ 异步调用版本化 Fake Parser，最终在网站中展示一组带可定位证据且状态为“待确认”的候选事实。

本切片延续 Issue #2 已建立的内部求职账户、会话、所有权、PostgreSQL、Redis、MinIO、Web/API/Worker、共享契约、OpenAPI 和脱敏审计边界。业务状态以 PostgreSQL 为权威来源；Redis 只承载队列，MinIO 只保存原始职业资料。

## 范围

本切片包含：

- 单个 UTF-8 Markdown 文件上传与明确的类型、大小、内容校验。
- 原始职业资料写入私有 `career-documents` bucket。
- 职业资料、导入状态、候选事实和画像证据的账户所有权与持久化。
- BullMQ 持久任务、有限重试、失败状态与幂等处理。
- 版本化 Fake Parser v1；测试和本地运行不访问真实模型。
- `/profile` 页面、短轮询状态、最近导入和待确认事实列表。
- 工作台真实待确认事实计数与职业资料入口。
- API、Worker、数据库、对象存储和 Web 的自动化测试。

本切片不包含：

- 候选事实的确认、修改、拒绝或求职画像版本；这些属于 Issue #4。
- DOCX、PDF、OCR、多文档冲突或冲突解决；这些属于 Issue #5。
- 真实 OpenAI Responses Adapter、SSE、Agent 运行或长期记忆。
- Markdown 下载、删除、分享或导出。
- 从文件内容推断联系方式、人格、求职目标或未明确写出的经历。

## 上游迁移边界

`MadsLorentzen/ai-job-search` 的 `/setup` 和候选人档案模板提供迁移参考：Markdown 是一级输入，技能、经历、教育、项目、语言、成果和证书应保持结构化，冲突和推断不得静默成为事实。

本网站不复用上游的 Claude Code 命令、跟踪文件或个人 Git 仓库作为运行时。上传、状态、证据和幂等性均由 Web、API、Worker、PostgreSQL、Redis 和对象存储承载。

## 总体架构

采用“数据库权威状态 + BullMQ 确定性任务”方案：

1. Web 将一个 Markdown 文件作为 multipart 请求发送给 API。
2. API 在内存上限内读取文件，执行文件名、MIME、字节数、UTF-8、空内容和 NUL 字节检查。
3. API 计算原始字节 SHA-256，并按当前 `userId + checksum` 查找已有职业资料。
4. 新文件在 PostgreSQL 事务内先预留 `career_documents` 记录，再写入 MinIO，并仅在对象写入成功后提交；重复文件复用已有记录，以账户内唯一键保证并发语义。
5. API 使用 `importId` 作为 BullMQ `jobId`，任务载荷只包含版本化标识、`importId` 和 `userId`，不包含正文、文件名或证据。新建、重新排队，以及命中 `queued` 或 `processing` 记录时都执行幂等入队；这是没有 Outbox 或恢复扫描器时，由用户重复上传触发的恢复语义。
6. Worker 从 PostgreSQL 获取对象引用并再次校验所有权，从 MinIO 读取原文，通过 Fake Parser v1 得到结构化输出。
7. Worker 用共享 Zod Schema 验证输出，并拒绝推断、缺少证据、未知字段、无效事实类型和越界行号。
8. Worker 在一个数据库事务中写入全部候选事实、证据、完成状态和脱敏审计；失败不会留下部分事实。
9. Web 每秒读取一次权威导入状态，在终态或页面卸载时停止轮询。

不采用事务 Outbox。本切片在数据库提交后入队；对 `queued` 导入，入队失败时把记录标记为 `failed/CAREER_IMPORT_QUEUE_UNAVAILABLE`，用户可以通过重新上传同一文件复用同一导入记录并重新入队。若进程恰好在数据库提交后、入队前退出，`queued` 或 `processing` 记录再次上传都会幂等补发任务。`processing` 的成功补发仍返回其当前 `200` 状态；若 Redis 不可用，则沿用现有请求错误行为，返回队列不可用且不改写该 `processing` 状态。该用户触发恢复语义可见、可修复且不产生重复领域数据，不需要提前引入 Outbox 分发器、租约和恢复扫描。

## 模块边界

### 共享契约

`@job-copilot/contracts` 定义：

- 文件限制常量和导入状态枚举。
- multipart API 的响应 DTO。
- 导入列表、导入详情、候选事实和证据 DTO。
- BullMQ 任务名、队列名、任务载荷和载荷版本。
- Fake Parser 输出的严格判别联合 Schema。

浏览器、API 和 Worker 都从同一契约解析未知输入。任何 Adapter 输出在进入领域服务之前都必须通过共享 Schema。

### 数据库

`@job-copilot/database` 只暴露 Schema、迁移和数据库客户端。数据库约束负责账户外键、唯一键、状态字段长度和必要字段非空；状态转换、幂等与候选事实规则属于领域模块。

### 领域模块

`@job-copilot/domain` 提供绑定数据库后的深模块接口：

- 创建或复用职业资料导入。
- 将失败导入重新排队。
- 获取账户拥有的导入列表与详情。
- 领取任务并转入 `processing`。
- 原子完成或失败导入。
- 计算工作台真实 `pendingFacts`。

调用方不直接拼接职业资料 SQL，也不接触数据库事务对象。

领域模块同时定义其所消费的窄端口：

- `CareerDocumentStore`：写入和读取原始职业资料。
- `CareerDocumentParser`：把不可信 Markdown 数据转换为版本化结构化输出。
- `CareerImportQueue`：按确定性任务 ID 入队。

### Adapter

- S3 Adapter 使用 AWS S3 兼容客户端连接 MinIO；API 写对象，Worker 读对象。
- BullMQ Producer 位于 API composition root；BullMQ Consumer 位于 Worker composition root。
- Fake Parser v1 是唯一模型 Adapter，不具有网络、邮件、文件系统或其他工具权限。

## 上传契约

上传请求只接受一个名为 `file` 的 multipart 文件：

- 文件扩展名必须为 `.md`，比较时不区分大小写。
- 最大原始字节数为 `524288`（512 KiB）。Fastify multipart 必须在读取阶段限制字节数，不能先无界读取再校验。
- 接受 `text/markdown` 和 `text/plain`。部分浏览器对 `.md` 使用空 MIME 或 `application/octet-stream`；只有扩展名、UTF-8 和内容检查同时通过时才接受这两种回退值。
- 使用严格 UTF-8 解码；非法字节、NUL 字节和仅含空白的内容被拒绝。
- 对象存储保存原始字节；SHA-256 也基于原始字节。
- 原始文件名只作为受长度限制的显示元数据保存，不能参与对象 key、日志或错误信息。

稳定错误码：

- `CAREER_DOCUMENT_REQUIRED`
- `TOO_MANY_CAREER_DOCUMENTS`
- `UNSUPPORTED_CAREER_DOCUMENT_TYPE`
- `CAREER_DOCUMENT_TOO_LARGE`
- `CAREER_DOCUMENT_INVALID_UTF8`
- `CAREER_DOCUMENT_EMPTY`
- `CAREER_DOCUMENT_STORAGE_UNAVAILABLE`
- `CAREER_IMPORT_QUEUE_UNAVAILABLE`

错误继续使用 Issue #2 的严格 `ApiProblem` 结构。

## 对象存储

对象 key 不包含用户文件名：

```text
accounts/{userId}/career-documents/{documentId}/source.md
```

对象元数据只包含内部 `documentId`、字节数和媒体类型，不包含邮箱、电话、文件名或正文摘要。bucket 保持私有；本切片不生成预签名下载 URL。

如果对象写入成功但数据库事务失败，确定性 key 可能留下一个不可见孤立对象。该对象不能被任何 API 枚举或读取；后续隐私删除工作统一清理。为避免在本切片引入对象垃圾回收器，不建立第二套补偿任务。

## 数据模型

### `career_documents`

- `id`: UUID 主键。
- `user_id`: 求职账户外键。
- `checksum_sha256`: 64 字符小写十六进制。
- `object_key`: 内部对象引用。
- `original_filename`: 受限显示名。
- `media_type`: 规范化为 `text/markdown`。
- `byte_size`: 非负整数且不超过 524288。
- `created_at`, `updated_at`。

唯一约束：`(user_id, checksum_sha256)`。

### `career_imports`

- `id`: UUID 主键，同时用作 BullMQ `jobId`。
- `user_id`, `career_document_id`。
- `status`: `queued | processing | completed | failed`。
- `parser_adapter`: 固定 `fake`。
- `parser_version`: 固定 `fake-career-parser-v1`。
- `prompt_version`: 固定 `career-import-prompt-v1`。
- `output_schema_version`: 固定 `career-facts-v1`。
- `attempt_count`: 每次 Worker 领取时递增。
- `failure_code`: 可空稳定错误码，不保存异常正文。
- `originating_request_id`: UUID，用于 API 与 Worker 审计关联。
- `queued_at`, `processing_started_at`, `completed_at`, `failed_at`, `created_at`, `updated_at`。

唯一约束：`(career_document_id, parser_version, prompt_version, output_schema_version)`。同一文档在同一解析版本下只存在一个导入记录；未来解析版本变化可以形成新的导入记录，而不覆盖历史结果。

### `candidate_facts`

- `id`: UUID 主键。
- `user_id`, `career_import_id`, `career_document_id`。
- `fact_key`: 基于解析版本、事实类型、规范化值和证据位置计算的 SHA-256。
- `fact_type`: `experience | education | skill | project | language | achievement | certification`。
- `fact_value`: 通过事实类型判别联合约束的 JSONB，不允许任意键。
- `confidence_basis_points`: `0..10000` 的整数。
- `confirmation_status`: 本切片固定为 `pending`。
- `created_at`。

唯一约束：`(career_import_id, fact_key)`。

### `candidate_fact_evidence`

- `id`: UUID 主键。
- `user_id`, `candidate_fact_id`, `career_document_id`。
- `locator_type`: 固定 `markdown_lines`。
- `start_line`, `end_line`: 从 1 开始的闭区间。
- `excerpt`: 支撑当前事实的最小原文片段。
- `excerpt_sha256`: 片段哈希。
- `created_at`。

一个候选事实在 Fake Parser v1 中只有一个直接证据片段。独立证据表保留未来多文档冲突的扩展空间，但本切片不实现冲突归并。

## 状态机与重试

允许的状态转换：

```text
queued → processing → completed
queued → processing → failed
queued → failed
failed → queued
```

- `completed` 是不可逆终态；重复任务直接成功返回，不重复解析或写入。
- 首次执行通过条件更新将 `queued` 改为 `processing`；同一 BullMQ 作业因异常或 Worker 中断而重投时，允许在 `processing` 上恢复同一个导入。BullMQ 对确定性 `jobId` 的锁负责阻止两个消费者同时执行；领域写入的唯一键和完成事务提供第二层幂等保护。
- BullMQ 自动尝试最多 3 次并使用指数退避。每次实际执行（包括恢复执行）递增 `attempt_count`。
- 可重试异常由 BullMQ 继续处理；最后一次失败时领域服务写入稳定 `failure_code`。
- 重新上传相同文件时：`completed` 返回已有结果；`queued` 与 `processing` 都返回当前状态并幂等补发同一个 `jobId`，其中 `processing` 成功补发仍返回当前 `200`；`failed` 原子恢复为 `queued` 并重新添加同一个 `jobId`。这是在没有 Outbox 或恢复扫描器时的用户触发恢复语义；`processing` 补发遇到 Redis 不可用时维持现有失败响应和数据库状态。
- API 入队失败允许 `queued → failed`，失败码为 `CAREER_IMPORT_QUEUE_UNAVAILABLE`；Worker 只有在最后一次执行失败后才写入其他稳定失败码。
- BullMQ 作业允许在成功或最终失败后移除；恢复能力来自 PostgreSQL 记录和重新上传，而不是保留 Redis 作业正文。

## Fake Parser v1

Fake Parser 是真实模型端口的确定性测试 Adapter，不冒充通用 AI：

- 支持中英文常见章节别名：技能、工作经历、教育、项目、语言、成果、证书。
- 只抽取标题和列表中明确出现的文本。
- 不根据措辞推断资历、熟练度、时间、指标或人格。
- 不生成姓名、邮箱、电话、地址和社交账号候选事实。
- 未识别章节被忽略。
- 没有产生任何受支持事实时以 `NO_SUPPORTED_FACTS` 失败。
- 输出包含固定 adapter、prompt、schema 版本，以及每个事实的类型、结构化值、置信度、grounding 和一个证据定位器。

领域层只接受 `grounding: quoted`。`inferred`、缺少证据、证据片段与指定行不一致、行号越界、未知字段或非法事实值都以稳定拒绝原因丢弃，不进入 `candidate_facts`。如果全部输出都被拒绝，导入以 `NO_SUPPORTED_FACTS` 失败。

合成测试简历覆盖：

- 一项工作经历及可核验成果。
- 两项技能。
- 一项教育经历。
- 一个项目。
- 一门语言及明确水平。

测试断言具体值和 Markdown 行号，不只断言事实数量。

## HTTP 与 OpenAPI

### `POST /v1/career-documents/imports`

- 需要 Bearer 会话认证。
- multipart 字段名固定为 `file`。
- 新建或重新入队返回 `202`；已存在且不需入队返回 `200`。
- 响应包含 `importId`、`documentId`、状态、是否复用和详情 URL。

### `GET /v1/career-documents/imports`

- 返回当前账户最近 20 条导入，按 `createdAt` 倒序。
- 每项包含显示文件名、状态、候选事实数量、稳定失败码和时间戳。
- 本切片不增加分页、搜索或删除。

### `GET /v1/career-documents/imports/:importId`

- 返回账户拥有的导入详情。
- `completed` 时返回按创建顺序排列的候选事实及证据；其他状态返回空事实数组。
- 不属于当前账户和不存在的 UUID 都返回 `404`。

三个操作都在 OpenAPI 中引用共享响应 Schema，并明确 Bearer security。multipart 上传文档必须列出文件格式和 512 KiB 上限。

## Web 体验

新增受保护的 `/profile` 页面：

- RSC 首次读取最近导入，Client Component 只负责文件选择、上传和短轮询。
- 文件输入接受 `.md`；上传按钮和文件输入具有关联标签、键盘操作和至少 44px 触控高度。
- 本地 UI 状态固定为：`上传中`、`等待解析`、`解析中`、`解析完成`、`解析失败`。
- 轮询间隔为 1 秒，只在 `queued` 或 `processing` 时运行；终态、导航离开和组件卸载时停止并取消请求。
- 页面刷新从 API 恢复权威状态，不依赖浏览器内存保存导入结果。
- 完成后显示事实类型、结构化值、来源文件、Markdown 行号、证据片段和“待确认”状态。
- 页面不提供确认、修改或拒绝控件，明确提示这些操作将在下一阶段开放。
- 失败显示面向求职者的稳定中文说明和重新选择同一文件的入口，不展示异常栈、对象 key 或内部队列信息。

工作台同步变化：

- 顶层“画像”导航进入 `/profile`。
- “待确认事实”读取真实 PostgreSQL 计数。
- 没有职业资料时保留诚实空状态并链接到 `/profile`。
- 有待确认事实时说明它们尚未进入求职画像，不能用于推荐或材料生成。

界面沿用现有产品风格，不重新设计营销页或引入新的品牌资产。桌面和移动端都必须保持无横向滚动、可见焦点、语义状态与 WCAG AA 基线。

## 所有权、安全和隐私

- API 从会话上下文取得 `userId`，不接受客户端提交 owner 字段。
- 所有查询同时按资源 ID 和 `userId` 过滤；跨账户访问与不存在资源均为 `404`。
- 对象 key 由服务端内部 ID 构造，不能使用文件名或用户路径。
- Worker 从任务载荷取得标识后仍以 `importId + userId` 查询权威记录，不能信任 Redis 载荷中的所有权声明。
- Markdown 永远作为不可信数据；Fake Parser 没有网络、邮件、Shell、外部行动或任意工具。
- 普通日志不得包含正文、文件名、对象 key、证据片段、联系方式、完整校验和或完整 Adapter 输入输出。
- 异常只映射到稳定失败码；原始异常可在测试断言中存在，但不得进入业务审计 metadata。

新增审计事件：

- `career.document_import_queued`
- `career.document_import_completed`
- `career.document_import_failed`

审计 metadata 使用逐事件严格白名单，只允许 `documentId`、`importId`、`attemptCount`、`factCount` 和稳定 `failureCode` 中与该事件相关的字段。Worker 沿用 `originating_request_id` 关联原始上传请求。

## 错误处理

上传边界错误返回 `400` 或 `413`；未认证返回 `401`；资源不可见返回 `404`。MinIO 或 Redis 在请求路径失败时返回 `503` 并保留可重试的业务状态。

Worker 稳定失败码：

- `CAREER_DOCUMENT_NOT_FOUND`
- `CAREER_DOCUMENT_READ_FAILED`
- `CAREER_DOCUMENT_CHECKSUM_MISMATCH`
- `CAREER_PARSER_OUTPUT_INVALID`
- `CAREER_PARSER_EVIDENCE_INVALID`
- `NO_SUPPORTED_FACTS`
- `CAREER_IMPORT_PERSIST_FAILED`

失败码是产品状态的一部分；异常消息不是。页面把失败码映射为简短中文说明。

## 测试策略

### 契约测试

- 上传响应、导入列表、导入详情、任务载荷和 Fake Parser 输出均拒绝未知字段。
- 逐类验证七种候选事实值和证据行号。
- 锁定 512 KiB、队列名、任务名和版本常量。

### 数据库与领域集成测试

- 迁移可重复执行，所有外键和唯一键生效。
- 相同账户和校验和复用职业资料；不同账户不复用。
- 状态机拒绝非法转换和重复完成。
- 候选事实、证据、完成状态和审计在同一事务提交；失败时全部回滚。
- 重复任务和失败重试不重复候选事实。
- 工作台 `pendingFacts` 只统计当前账户的待确认事实。

### Adapter 与 Worker 测试

- S3 Adapter 通过受控对象存储验证原始字节往返和不存在对象。
- Fake Parser 使用合成 Markdown 断言具体事实、值、置信度、证据片段和行号。
- 推断、缺证据、越界和非法 Schema 不进入数据库。
- Worker 使用真实 PostgreSQL、Redis、MinIO 和 BullMQ，使用 Fake Parser，不访问真实模型。
- Worker shutdown 先停止接收任务并等待当前任务结束，再关闭队列、Redis、对象存储客户端和应用上下文。

### API 测试

- 覆盖有效上传、重复上传、失败重试、文件缺失、多文件、扩展名、MIME、大小、UTF-8、空内容和 NUL。
- 覆盖未认证、旧会话、跨账户详情和 OpenAPI multipart/security Schema。
- 测试日志和审计记录不包含合成简历正文、文件名或联系方式。

### Playwright

使用真实 Web、API、Worker、PostgreSQL、Redis、MinIO 和 BullMQ，加版本化 Fake Parser：

1. Dev Auth 登录。
2. 上传合成 Markdown。
3. 观察等待解析或解析中状态。
4. 等待解析完成并查看具体候选事实和精确证据行号。
5. 刷新页面，确认状态和事实来自持久化记录。
6. 重复上传同一文件，确认复用同一个导入且事实数量不变。
7. 第二账户无法读取第一账户导入。
8. Desktop Chrome 与 Mobile Safari 覆盖真实点击、触控尺寸、无横向溢出和 axe；完整 Tab 顺序仍由 Desktop Chrome 验证。

测试不访问真实模型，不使用测试专属数据库捷径，不把营销示例数据当成当前用户数据。

## 验收映射

- 上传限制和状态：上传契约、`career_imports` 状态机与 `/profile`。
- 原文对象存储：私有 MinIO bucket、确定性对象 key、数据库对象引用。
- Worker + Fake 模型：BullMQ Consumer、Fake Parser v1、严格输出 Schema 和版本字段。
- 候选事实与证据：严格事实联合、Markdown 行号、最小证据片段和固定 `pending`。
- 未证实内容隔离：只接受直接引用且证据有效的输出，本切片不创建求职画像事实。
- 幂等：账户内校验和唯一、版本化导入唯一、确定性 jobId 和事务写入。
- 全流程验收：真实本地全栈 Playwright，不访问外部模型。

## 后续边界

- Issue #4 消费待确认候选事实并创建用户确认、纠正、拒绝和主要求职画像版本。
- Issue #5 在相同职业资料、导入、候选事实和证据模型上增加 DOCX/PDF Adapter 与冲突记录，不建立平行数据模型。
- 后续真实模型 Adapter 必须实现同一个 `CareerDocumentParser` 端口，并记录新的 adapter、prompt 和 schema 版本；不能覆盖 Fake Parser v1 的历史结果。
- 后续 SSE 可以替换 Web 的短轮询 transport，但不能改变 PostgreSQL 权威状态或领域状态机。

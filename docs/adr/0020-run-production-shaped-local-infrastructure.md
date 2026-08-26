# 本地运行接近生产形态的基础设施

本地 Beta 通过 Docker Compose 启动 PostgreSQL、Redis、MinIO 和 Mailpit，Web、API 与 Worker 使用未来生产相同的数据库、队列、对象存储和邮件接口。测试可以使用 Fake Adapter，但不以 SQLite、内存队列或散落本地文件建立第二套数据模型和任务语义。

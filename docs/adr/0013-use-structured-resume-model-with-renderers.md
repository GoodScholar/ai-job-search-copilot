# 使用结构化简历模型与多格式 Renderer

结构化 Resume Model 是简历内容的唯一事实来源，每次确认后形成不可变简历版本；Markdown、DOCX 和 PDF 均由同一版本渲染，LaTeX 可在后续作为高级 Renderer Adapter 加入。Markdown 是一等导入导出格式，但用户修改或导入 Markdown 时，系统先解析成简历草稿并展示差异，确认后才创建新版本，避免数据库与文件形成双重事实来源。

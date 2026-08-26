# 本地 Beta 使用 OpenAI Responses API

首个模型生产 Adapter 使用 OpenAI Responses API，并以 JSON Schema Structured Outputs 返回领域结果。`gpt-5.6-luna` 处理简历解析、岗位规范化、初筛和去重，`gpt-5.6-terra` 处理深度匹配、定制简历和材料审核；`gpt-5.6-sol` 只用于离线评测或疑难质量分析，不进入默认用户链路。应用自己保存结构化状态，不把供应商对话状态作为长期记忆。

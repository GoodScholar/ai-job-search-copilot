import { RunPreflightProblemSchema, type RunPreflightCheckCode, type RunPreflightProblem } from "@job-copilot/contracts/run-preflight";

const copy: Record<RunPreflightCheckCode, readonly [string, string]> = {
  PROFILE_EVIDENCE_MISSING: ["缺少可用画像事实", "请先确认至少一条画像事实后再启动运行。"],
  PROFILE_EVIDENCE_READY: ["画像事实已就绪", "当前画像事实可用于本次运行。"],
  PRIMARY_JOB_TARGET_MISSING: ["缺少活动主目标", "请先设置一个活动主求职目标。"],
  PRIMARY_JOB_TARGET_READY: ["主目标已就绪", "当前活动主目标可用于本次运行。"],
  REQUESTED_JOB_TARGET_MISSING: ["请求的目标不存在", "请选择当前账户中的求职目标。"],
  REQUESTED_JOB_TARGET_INACTIVE: ["请求的目标未启用", "请启用该求职目标或选择其他目标。"],
  REQUESTED_JOB_TARGET_READY: ["请求目标已就绪", "请求的活动目标可用于本次运行。"],
  SOURCE_CAPABILITY_UNAVAILABLE: ["没有可执行的真实来源", "请配置并启用支持的 Greenhouse 来源。"],
  SOURCE_CAPABILITY_PARTIAL: ["部分来源能力不足", "部分启用来源不能满足本次运行所需能力。"],
  SOURCE_CAPABILITY_READY: ["来源能力已就绪", "启用的真实来源满足本次运行能力要求。"],
  SOURCE_CAPABILITY_NOT_REQUIRED: ["来源能力无需检查", "深度匹配不直接执行来源发现。"],
  SOURCE_HEALTH_UNCHECKED: ["来源尚未完成健康检查", "运行可以继续，建议稍后查看来源健康状态。"],
  SOURCE_HEALTH_DEGRADED: ["部分来源健康异常", "运行可以继续，建议检查异常来源。"],
  SOURCE_HEALTH_READY: ["来源健康已就绪", "已检查来源当前没有退化状态。"],
  SOURCE_HEALTH_NOT_REQUIRED: ["来源健康无需检查", "深度匹配不直接执行来源发现。"],
  MODEL_DIAGNOSTIC_UNAVAILABLE: ["模型诊断不可用", "请先完成模型连接检查。"],
  MODEL_DIAGNOSTIC_READY: ["模型诊断已就绪", "当前模型诊断显示可安全使用。"],
  ACCOUNT_RUN_POLICY_BLOCKED: ["账户运行策略或全局停止阻止启动", "请检查运行预算、后台时间窗口或解除全局停止。"],
  ACCOUNT_RUN_POLICY_READY: ["账户运行策略已就绪", "当前预算和时间窗口允许本次运行。"],
};

export function projectRecommendationRunPreflightProblem(input: unknown): RunPreflightProblem | null {
  const parsed = RunPreflightProblemSchema.safeParse(input);
  if (!parsed.success) return null;
  const problem = parsed.data;
  return {
    code: problem.code,
    message: problem.code === "RUN_PREFLIGHT_BLOCKED" ? "运行前检查未通过" : "请确认当前运行前检查提示",
    preflight: {
      ...problem.preflight,
      items: problem.preflight.items.map((item) => ({ ...item, summary: copy[item.code][0], impact: copy[item.code][1] })),
    },
  };
}

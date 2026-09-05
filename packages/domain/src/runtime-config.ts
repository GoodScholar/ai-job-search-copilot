import { z } from "zod";

const RuntimeConfigSchema = z.object({
  APP_ENV: z.enum(["local", "test", "production"]),
  AUTH_MODE: z.enum(["dev", "wechat"]),
  DEV_AUTH_SHARED_SECRET: z.string().min(32).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_ENDPOINT: z.string().url().optional(),
  OPENAI_ORGANIZATION: z.string().min(1).optional(),
  OPENAI_PROJECT: z.string().min(1).optional(),
  OPENAI_LOW_COST_MODEL: z.string().min(1).optional(),
  OPENAI_HIGH_QUALITY_MODEL: z.string().min(1).optional(),
}).strict().superRefine((config, context) => {
  if (config.APP_ENV === "production" && config.AUTH_MODE === "dev") {
    context.addIssue({
      code: "custom",
      message: "正式环境不能启用 Dev Auth",
      path: ["AUTH_MODE"],
    });
  }

  if (config.AUTH_MODE === "dev" && !config.DEV_AUTH_SHARED_SECRET) {
    context.addIssue({
      code: "custom",
      message: "Dev Auth 必须配置至少 32 字符的共享密钥",
      path: ["DEV_AUTH_SHARED_SECRET"],
    });
  }
});

export type RuntimeConfig = Omit<z.infer<typeof RuntimeConfigSchema>, "OPENAI_API_KEY" | "OPENAI_ENDPOINT" | "OPENAI_ORGANIZATION" | "OPENAI_PROJECT" | "OPENAI_LOW_COST_MODEL" | "OPENAI_HIGH_QUALITY_MODEL"> & { openAi: { apiKey?: string; endpoint?: string; organization?: string; project?: string; lowCostModel: string; highQualityModel: string } };

export function parseRuntimeConfig(input: {
  APP_ENV?: unknown;
  AUTH_MODE?: unknown;
  DEV_AUTH_SHARED_SECRET?: unknown;
  OPENAI_API_KEY?: unknown;
  OPENAI_ENDPOINT?: unknown;
  OPENAI_ORGANIZATION?: unknown;
  OPENAI_PROJECT?: unknown;
  OPENAI_LOW_COST_MODEL?: unknown;
  OPENAI_HIGH_QUALITY_MODEL?: unknown;
}): RuntimeConfig {
  const parsed = RuntimeConfigSchema.parse(input);
  const { OPENAI_API_KEY: apiKey, OPENAI_ENDPOINT: endpoint, OPENAI_ORGANIZATION: organization, OPENAI_PROJECT: project, OPENAI_LOW_COST_MODEL: lowCostModel = "gpt-5.6-luna", OPENAI_HIGH_QUALITY_MODEL: highQualityModel = "gpt-5.6-terra", ...safe } = parsed;
  return { ...safe, openAi: { apiKey, endpoint, organization, project, lowCostModel, highQualityModel } };
}

import { z } from "zod";

const RuntimeConfigSchema = z.object({
  APP_ENV: z.enum(["local", "test", "production"]),
  AUTH_MODE: z.enum(["dev", "wechat"]),
  DEV_AUTH_SHARED_SECRET: z.string().min(32).optional(),
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

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function parseRuntimeConfig(input: {
  APP_ENV?: unknown;
  AUTH_MODE?: unknown;
  DEV_AUTH_SHARED_SECRET?: unknown;
}): RuntimeConfig {
  return RuntimeConfigSchema.parse(input);
}

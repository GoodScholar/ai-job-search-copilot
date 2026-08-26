type PublicEnv = {
  NEXT_PUBLIC_AUTH_MODE?: string;
};

export function getPublicAuthMode(env: PublicEnv): "dev" | "wechat" {
  return env.NEXT_PUBLIC_AUTH_MODE === "wechat" ? "wechat" : "dev";
}

export function resolveInternalReturnTo(
  value: string | string[] | null | undefined,
): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

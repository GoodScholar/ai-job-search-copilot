type PublicEnv = {
  NEXT_PUBLIC_AUTH_MODE?: string;
};

const internalOrigin = "https://ai-job-search-copilot.local";
const controlCharacter = /[\u0000-\u001f\u007f]/;

export function getPublicAuthMode(env: PublicEnv): "dev" | "wechat" {
  return env.NEXT_PUBLIC_AUTH_MODE === "wechat" ? "wechat" : "dev";
}

export function resolveInternalReturnTo(
  value: string | string[] | null | undefined,
): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    controlCharacter.test(value)
  ) {
    return "/";
  }

  const resolved = new URL(value, internalOrigin);

  return resolved.origin === internalOrigin
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : "/";
}

export function resolveLoginReturnTo(value: string | string[] | null | undefined): string {
  if (value === "/") {
    return "/";
  }

  const returnTo = resolveInternalReturnTo(value);
  return returnTo === "/" ? "/home" : returnTo;
}

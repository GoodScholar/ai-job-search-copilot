import "server-only";

import { cookies } from "next/headers";

export const sessionCookieName = "job_copilot_session";

type SessionCookieOptionsInput = {
  appEnv: string | undefined;
  expiresAt: Date;
};

export function sessionCookieOptions({ appEnv, expiresAt }: SessionCookieOptionsInput) {
  return {
    httpOnly: true,
    secure: appEnv === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export async function readSessionToken(): Promise<string | null> {
  return (await cookies()).get(sessionCookieName)?.value ?? null;
}

export async function writeSessionCookie(sessionToken: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(
    sessionCookieName,
    sessionToken,
    sessionCookieOptions({ appEnv: process.env.APP_ENV, expiresAt }),
  );
}

export async function deleteSessionCookie(): Promise<void> {
  (await cookies()).delete({ name: sessionCookieName, path: "/" });
}

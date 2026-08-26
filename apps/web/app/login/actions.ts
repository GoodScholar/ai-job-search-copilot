"use server";

import { redirect } from "next/navigation";
import { resolveLoginReturnTo } from "@/lib/auth-mode";
import { api } from "@/lib/server/api-client";
import { deleteSessionCookie, readSessionToken, writeSessionCookie } from "@/lib/server/session-cookie";

export async function startDevSessionAction(formData: FormData): Promise<never> {
  const started = await api.startDevSession({ subject: "local-primary" });
  await writeSessionCookie(started.sessionToken, new Date(started.expiresAt));
  const returnTo = formData.get("returnTo");
  redirect(resolveLoginReturnTo(typeof returnTo === "string" ? returnTo : undefined));
}

export async function endSessionAction(): Promise<{ error: string } | never> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) {
    await deleteSessionCookie();
    redirect("/login");
  }

  try {
    await api.endCurrentSession(sessionToken);
  } catch {
    return { error: "退出失败，请稍后重试。" };
  }

  await deleteSessionCookie();
  redirect("/login");
}

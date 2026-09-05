import "server-only";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";
export async function getAccountRunPolicy() {
  const token = await readSessionToken(); if (!token) redirect("/login?returnTo=%2Fprofile%2Frun-policy");
  return api.getAccountRunPolicy(token);
}

"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";

function SubmitButton({ pending }: { pending: boolean }) {
  return <Button className="workbench-touch-target" disabled={pending} size="lg" type="submit">{pending ? "正在提交重新评估…" : "重新评估此岗位"}</Button>;
}

/** A single user intent owns one stable key until the server action settles. */
export function ReevaluationForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const [initialKey] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(async (current: { key: string; failed: boolean }, formData: FormData) => {
    try {
      await action(formData);
      return { key: crypto.randomUUID(), failed: false };
    } catch {
      return { ...current, failed: true };
    }
  }, { key: initialKey, failed: false });
  return <form action={formAction}><input name="idempotencyKey" type="hidden" value={state.key} />{state.failed ? <p role="alert">重新评估未启动，请重试。</p> : null}<SubmitButton pending={pending} /></form>;
}

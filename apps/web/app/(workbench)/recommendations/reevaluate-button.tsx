"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";

function SubmitButton({ pending }: { pending: boolean }) {
  return <Button className="workbench-touch-target" disabled={pending} size="lg" type="submit">{pending ? "正在提交重新评估…" : "重新评估此岗位"}</Button>;
}

/** A single user intent owns one stable key until the server action settles. */
export function ReevaluationForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const [initialKey] = useState(() => crypto.randomUUID());
  const [state, formAction, pending] = useActionState(async (current: { key: string }, formData: FormData) => {
    await action(formData);
    return { key: crypto.randomUUID() };
  }, { key: initialKey });
  return <form action={formAction}><input name="idempotencyKey" type="hidden" value={state.key} /><SubmitButton pending={pending} /></form>;
}

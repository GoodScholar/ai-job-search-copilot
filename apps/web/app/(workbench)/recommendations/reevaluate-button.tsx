"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <Button className="workbench-touch-target" disabled={pending} size="lg" type="submit">{pending ? "正在提交重新评估…" : "重新评估此岗位"}</Button>;
}

/** A single user intent owns one stable key until the server action settles. */
export function ReevaluationForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const idempotencyKey = useRef(crypto.randomUUID());
  return <form action={action}><input name="idempotencyKey" type="hidden" value={idempotencyKey.current} /><SubmitButton /></form>;
}

"use client";

import {
  AgentInboxActionResponseSchema,
  type AgentInboxActionCommand,
  type AgentInboxItem,
} from "@job-copilot/contracts/agent-inbox";
import Link from "next/link";
import { useRef, useState } from "react";

const actionLabels: Record<AgentInboxActionCommand["action"], string> = {
  restart_run: "重新开始岗位发现",
  resume_run: "继续本次岗位发现",
  cancel_run: "取消岗位发现",
  dismiss: "标记已处理",
};

export function AgentInboxPanel({ items, onResolved }: { items: AgentInboxItem[]; onResolved: (itemId: string) => void }) {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const actionIds = useRef(new Map<string, string>());

  async function actOn(item: AgentInboxItem, action: AgentInboxActionCommand["action"]) {
    const key = `${item.itemId}:${action}`;
    const actionId = actionIds.current.get(key) ?? crypto.randomUUID();
    actionIds.current.set(key, actionId);
    setPending(key);
    setMessage("");
    try {
      const response = await fetch(`/api/agent-inbox/${item.itemId}/actions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId, action }),
      });
      if (!response.ok) {
        if (response.status === 409) actionIds.current.delete(key);
        setMessage(response.status === 409 ? "该事项状态已变化，请刷新后查看。" : "暂时无法处理该事项，请稍后重试。");
        return;
      }
      const parsed = AgentInboxActionResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        setMessage("暂时无法处理该事项，请稍后重试。");
        return;
      }
      actionIds.current.delete(key);
      if (parsed.data.item.status === "resolved") {
        onResolved(item.itemId);
        setMessage("事项已处理。");
      } else {
        setMessage("事项状态已更新。");
      }
    } catch {
      setMessage("暂时无法处理该事项，请稍后重试。");
    } finally {
      setPending(null);
    }
  }

  if (items.length === 0 && !message) return null;

  return (
    <section aria-labelledby="agent-inbox-title" className="workbench-ledger agent-inbox-panel">
      <div className="workbench-ledger-heading">
        <p>Agent Inbox · 待处理</p>
        <h2 id="agent-inbox-title">需要你决定的事项</h2>
      </div>
      <p aria-live="polite" className={message ? "agent-inbox-live" : "agent-inbox-live is-empty"} role="status">{message}</p>
      <div className="agent-inbox-list">
        {items.map((item) => (
          <article aria-label={item.title} key={item.itemId}>
            <h3>{item.title}</h3>
            <p>{item.message}</p>
            <div className="agent-inbox-actions">
              {item.targetHref ? <Link className="workbench-ledger-link workbench-touch-target" href={item.targetHref}>调整求职目标</Link> : null}
              {item.availableActions.map((action) => {
                const key = `${item.itemId}:${action}`;
                return <button className="agent-run-action workbench-touch-target" disabled={pending === key} key={action} onClick={() => void actOn(item, action)} type="button">
                  {pending === key ? "正在处理…" : `${actionLabels[action]}：${item.title}`}
                </button>;
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

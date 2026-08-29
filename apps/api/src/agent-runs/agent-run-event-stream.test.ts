import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import { createAgentRunEventStream, resolveAgentRunEventCursor } from "./agent-run-event-stream.js";

const userId = "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3";
const runId = "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
const createdAt = "2026-08-29T08:00:00.000Z";

const queuedEvent: AgentRunDetail["events"][number] = {
  sequence: 1,
  runVersion: 1,
  eventType: "run.queued",
  data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 },
  createdAt,
};
const startedEvent: AgentRunDetail["events"][number] = {
  sequence: 2,
  runVersion: 2,
  eventType: "run.started",
  data: { eventType: "run.started", status: "running", currentStep: "batch_search", attemptCount: 1 },
  createdAt,
};
const completedEvent: AgentRunDetail["events"][number] = {
  sequence: 3,
  runVersion: 3,
  eventType: "run.completed",
  data: { eventType: "run.completed", status: "completed", currentStep: "completed", attemptCount: 1, resultCount: 2 },
  createdAt,
};
const pauseRequestedEvent: AgentRunDetail["events"][number] = {
  sequence: 3,
  runVersion: 3,
  eventType: "run.pause_requested",
  data: { eventType: "run.pause_requested", status: "running", currentStep: "fetch_details", attemptCount: 1 },
  createdAt,
};
const pausedEvent: AgentRunDetail["events"][number] = {
  sequence: 4,
  runVersion: 4,
  eventType: "run.paused",
  data: { eventType: "run.paused", status: "paused", currentStep: "fetch_details", attemptCount: 1 },
  createdAt,
};
const resumeRequestedEvent: AgentRunDetail["events"][number] = {
  sequence: 3,
  runVersion: 3,
  eventType: "run.resume_requested",
  data: { eventType: "run.resume_requested", status: "running", currentStep: "fetch_details", attemptCount: 1 },
  createdAt,
};
const cancelledEvent: AgentRunDetail["events"][number] = {
  sequence: 3,
  runVersion: 3,
  eventType: "run.cancelled",
  data: { eventType: "run.cancelled", status: "cancelled", currentStep: "cancelled", attemptCount: 1 },
  createdAt,
};
const cancelRequestedEvent: AgentRunDetail["events"][number] = {
  sequence: 3,
  runVersion: 3,
  eventType: "run.cancel_requested",
  data: { eventType: "run.cancel_requested", status: "running", currentStep: "fetch_details", attemptCount: 1 },
  createdAt,
};
const failedEvent: AgentRunDetail["events"][number] = {
  sequence: 3,
  runVersion: 3,
  eventType: "run.failed",
  data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: 1, failureCode: "AGENT_RUN_ADAPTER_FAILED" },
  createdAt,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Agent Run SSE", () => {
  it("从游标零完整有序回放脱敏事件，并在终态后关闭", async () => {
    const eventsAfter = vi.fn().mockResolvedValue([queuedEvent, startedEvent, completedEvent]);
    const stream = createAgentRunEventStream({ queries: { eventsAfter }, userId, runId, afterSequence: 0 });

    const text = await readAll(stream);

    expect(eventsAfter).toHaveBeenCalledWith({ userId, runId, afterSequence: 0 });
    expect(text).toBe([
      'id: 1\nevent: run.queued\ndata: {"id":"1","event":"run.queued","runVersion":1,"data":{"eventType":"run.queued","status":"queued","currentStep":"queued","attemptCount":0}}\n\n',
      'id: 2\nevent: run.started\ndata: {"id":"2","event":"run.started","runVersion":2,"data":{"eventType":"run.started","status":"running","currentStep":"batch_search","attemptCount":1}}\n\n',
      'id: 3\nevent: run.completed\ndata: {"id":"3","event":"run.completed","runVersion":3,"data":{"eventType":"run.completed","status":"completed","currentStep":"completed","attemptCount":1,"resultCount":2}}\n\n',
    ].join(""));
    expect(text).not.toMatch(/createdAt|rawPayload|description|objectKey/);
    expect(text).toContain('"runVersion":3');
  });

  it.each([
    ["2", undefined, 2],
    [undefined, "1", 1],
    ["1", "2", 2],
  ] as const)("选择 Last-Event-ID=%s 与 afterEventId=%s 的较大合法游标", (lastEventId, afterEventId, expected) => {
    expect(resolveAgentRunEventCursor({ lastEventId, afterEventId })).toBe(expected);
  });

  it("从已确认游标之后继续回放且不重复旧事件", async () => {
    const eventsAfter = vi.fn().mockResolvedValue([completedEvent]);
    const afterSequence = resolveAgentRunEventCursor({ lastEventId: "1", afterEventId: "2" });

    const text = await readAll(createAgentRunEventStream({ queries: { eventsAfter }, userId, runId, afterSequence }));

    expect(eventsAfter).toHaveBeenCalledWith({ userId, runId, afterSequence: 2 });
    expect(text).toContain("id: 3");
    expect(text).not.toContain("id: 1");
    expect(text).not.toContain("id: 2");
  });

  it.each([
    ["paused", pausedEvent],
    ["cancelled", cancelledEvent],
    ["completed", completedEvent],
    ["failed", failedEvent],
  ] as const)("%s 事件终止流", async (_name, event) => {
    const eventsAfter = vi.fn().mockResolvedValue([event]);
    const text = await readAll(createAgentRunEventStream({ queries: { eventsAfter }, userId, runId, afterSequence: event.sequence - 1 }));
    expect(text).toContain(`event: ${event.eventType}`);
    expect(eventsAfter).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["pause_requested", pauseRequestedEvent],
    ["resume_requested", resumeRequestedEvent],
    ["cancel_requested", cancelRequestedEvent],
  ] as const)("%s 事件不终止流", async (_name, event) => {
    const completedAfterRequest = { ...completedEvent, sequence: event.sequence + 1, runVersion: event.runVersion + 1 };
    const eventsAfter = vi.fn().mockResolvedValue([event, completedAfterRequest]);
    const text = await readAll(createAgentRunEventStream({ queries: { eventsAfter }, userId, runId, afterSequence: event.sequence - 1 }));
    expect(text).toContain(`event: ${event.eventType}`);
    expect(text).toContain("event: run.completed");
  });

  it("安全暂停后可从旧游标恢复且不重复", async () => {
    const resumedCompleted = { ...completedEvent, sequence: 5, runVersion: 5 };
    const resumedEventsAfter = vi.fn().mockResolvedValue([resumedCompleted]);
    const resumed = await readAll(createAgentRunEventStream({ queries: { eventsAfter: resumedEventsAfter }, userId, runId, afterSequence: 4 }));
    expect(resumed).toContain("id: 5");
    expect(resumed).not.toContain("id: 4");
  });

  it("终态游标已被客户端确认时立即关闭而不继续轮询", async () => {
    const eventsAfter = vi.fn().mockResolvedValue([]);
    const stream = createAgentRunEventStream({
      queries: { eventsAfter }, userId, runId, afterSequence: 3, terminalSequence: 3,
    });

    await expect(stream.getReader().read()).resolves.toEqual({ done: true, value: undefined });
    expect(eventsAfter).not.toHaveBeenCalled();
  });

  it("历史三条事件只查询一次，按消费者 pull 连续有序回放且不等待轮询间隔", async () => {
    vi.useFakeTimers();
    const allEvents = [queuedEvent, startedEvent, completedEvent];
    const eventsAfter = vi.fn(async ({ afterSequence }: { afterSequence: number }) => (
      allEvents.filter((event) => event.sequence > afterSequence)
    ));
    const reader = createAgentRunEventStream({ queries: { eventsAfter }, userId, runId, afterSequence: 0 }).getReader();
    await vi.advanceTimersByTimeAsync(0);
    expect(eventsAfter).toHaveBeenCalledTimes(1);

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("id: 1");
    let second: ReadableStreamReadResult<Uint8Array> | undefined;
    void reader.read().then((chunk) => { second = chunk; });
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBeDefined();
    expect(new TextDecoder().decode(second?.value)).toContain("id: 2");
    let third: ReadableStreamReadResult<Uint8Array> | undefined;
    void reader.read().then((chunk) => { third = chunk; });
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toBeDefined();
    expect(new TextDecoder().decode(third?.value)).toContain("id: 3");
    expect(eventsAfter).toHaveBeenCalledTimes(1);
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("查询在途仍按十五秒发送心跳，迟到事件等待容量后再推进游标", async () => {
    vi.useFakeTimers();
    const deferred = promiseWithResolvers<AgentRunDetail["events"]>();
    const eventsAfter = vi.fn().mockReturnValue(deferred.promise);
    const reader = createAgentRunEventStream({ queries: { eventsAfter }, userId, runId, afterSequence: 0 }).getReader();
    await vi.advanceTimersByTimeAsync(0);
    expect(eventsAfter).toHaveBeenCalledWith({ userId, runId, afterSequence: 0 });

    await vi.advanceTimersByTimeAsync(15_000);
    deferred.resolve([queuedEvent]);
    await vi.advanceTimersByTimeAsync(0);

    const heartbeat = await reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toBe(": heartbeat\n\n");
    const event = await reader.read();
    expect(new TextDecoder().decode(event.value)).toContain("id: 1");
    expect(eventsAfter).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(eventsAfter).toHaveBeenLastCalledWith({ userId, runId, afterSequence: 1 });
    await reader.cancel();
  });

  it("心跳填满下游容量后暂停 heartbeat 与数据库轮询，消费后恢复", async () => {
    vi.useFakeTimers();
    const eventsAfter = vi.fn().mockResolvedValue([]);
    const reader = createAgentRunEventStream({ queries: { eventsAfter }, userId, runId, afterSequence: 0 }).getReader();

    await vi.advanceTimersByTimeAsync(15_000);
    const callsAtBackpressure = eventsAfter.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(eventsAfter).toHaveBeenCalledTimes(callsAtBackpressure);

    const heartbeat = await reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toBe(": heartbeat\n\n");
    await vi.advanceTimersByTimeAsync(250);
    expect(eventsAfter.mock.calls.length).toBeGreaterThan(callsAtBackpressure);
    await reader.cancel();
  });

  it("空闲十五秒发送注释心跳并继续轮询数据库", async () => {
    vi.useFakeTimers();
    const eventsAfter = vi.fn().mockResolvedValue([]);
    const reader = createAgentRunEventStream({ queries: { eventsAfter }, userId, runId, afterSequence: 0 }).getReader();
    const next = reader.read();

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(next).resolves.toEqual({ done: false, value: new TextEncoder().encode(": heartbeat\n\n") });
    expect(eventsAfter.mock.calls.length).toBeGreaterThan(1);
    await reader.cancel();
  });

  it("请求中止后清理计时器、停止查询并关闭流", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const eventsAfter = vi.fn().mockResolvedValue([]);
    const reader = createAgentRunEventStream({
      queries: { eventsAfter }, userId, runId, afterSequence: 0, signal: controller.signal,
    }).getReader();
    await vi.advanceTimersByTimeAsync(250);
    const callsBeforeAbort = eventsAfter.mock.calls.length;

    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(eventsAfter).toHaveBeenCalledTimes(callsBeforeAbort);
  });

  it.each(["resolve", "reject"] as const)("pending 查询期间 abort，迟到 %s 不写流且不产生未处理拒绝", async (settlement) => {
    const deferred = promiseWithResolvers<AgentRunDetail["events"]>();
    const eventsAfter = vi.fn().mockReturnValue(deferred.promise);
    const abort = new AbortController();
    const reader = createAgentRunEventStream({
      queries: { eventsAfter }, userId, runId, afterSequence: 0, signal: abort.signal,
    }).getReader();
    await Promise.resolve();
    expect(eventsAfter).toHaveBeenCalledTimes(1);

    abort.abort();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    if (settlement === "resolve") deferred.resolve([queuedEvent]);
    else deferred.reject(new Error("late database failure"));
    await Promise.resolve();
    await Promise.resolve();

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(eventsAfter).toHaveBeenCalledTimes(1);
  });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function promiseWithResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

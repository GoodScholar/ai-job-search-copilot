import {
  AgentRunSseCursorSchema,
  AgentRunSseEventSchema,
  type AgentRunDetail,
} from "@job-copilot/contracts/agent-runs";

const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 15_000;
const terminalEvents = new Set(["run.completed", "run.failed"]);

type EventQueries = {
  eventsAfter(input: { userId: string; runId: string; afterSequence: number }): Promise<AgentRunDetail["events"] | null>;
};

export function resolveAgentRunEventCursor(input: {
  lastEventId?: string;
  afterEventId?: string;
}): number {
  const values = [input.lastEventId, input.afterEventId]
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(AgentRunSseCursorSchema.parse(value)));
  return values.length === 0 ? 0 : Math.max(...values);
}

export function createAgentRunEventStream(input: {
  queries: EventQueries;
  userId: string;
  runId: string;
  afterSequence: number;
  terminalSequence?: number;
  signal?: AbortSignal;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cursor = input.afterSequence;
  let stopped = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingEvents: AgentRunDetail["events"] = [];
  let stop: (() => void) | undefined;
  let requestMore: (() => void | Promise<void>) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let hasPolled = false;
      const hasCapacity = () => (controller.desiredSize ?? 0) > 0;
      const clearTimers = () => {
        if (pollTimer) clearTimeout(pollTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        pollTimer = undefined;
        heartbeatTimer = undefined;
      };
      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        pendingEvents = [];
        clearTimers();
        input.signal?.removeEventListener("abort", finish);
      };
      const finish = () => {
        if (stopped) return;
        cleanup();
        controller.close();
      };
      const fail = (error: unknown) => {
        if (stopped) return;
        stopped = true;
        clearTimers();
        input.signal?.removeEventListener("abort", finish);
        controller.error(error);
      };
      const scheduleHeartbeat = () => {
        if (stopped || heartbeatTimer || !hasCapacity()) return;
        heartbeatTimer = setTimeout(() => {
          heartbeatTimer = undefined;
          if (stopped || !hasCapacity()) return;
          if (polling) {
            scheduleHeartbeat();
            return;
          }
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          scheduleHeartbeat();
        }, HEARTBEAT_INTERVAL_MS);
      };
      const schedulePoll = () => {
        if (stopped || polling || pollTimer || pendingEvents.length > 0 || !hasCapacity()) return;
        pollTimer = setTimeout(() => {
          pollTimer = undefined;
          if (stopped || !hasCapacity()) return;
          void poll();
        }, POLL_INTERVAL_MS);
      };
      const emitPendingEvent = () => {
        if (stopped || pendingEvents.length === 0 || !hasCapacity()) return;
        const event = pendingEvents[0];
        const sse = AgentRunSseEventSchema.parse({
          id: String(event.sequence),
          event: event.eventType,
          data: event.data,
        });
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;
        controller.enqueue(encoder.encode(`id: ${sse.id}\nevent: ${sse.event}\ndata: ${JSON.stringify(sse.data)}\n\n`));
        pendingEvents.shift();
        cursor = event.sequence;
        if (terminalEvents.has(event.eventType)) {
          finish();
          return;
        }
        if (pendingEvents.length === 0 && hasCapacity()) {
          scheduleHeartbeat();
          schedulePoll();
        }
      };
      const poll = async () => {
        if (stopped || polling || pendingEvents.length > 0 || !hasCapacity()) return;
        polling = true;
        try {
          const events = await input.queries.eventsAfter({
            userId: input.userId,
            runId: input.runId,
            afterSequence: cursor,
          });
          if (stopped) return;
          if (events === null) {
            finish();
            return;
          }
          pendingEvents = events.filter((candidate) => candidate.sequence > cursor);
          emitPendingEvent();
        } catch (error) {
          fail(error);
          return;
        } finally {
          polling = false;
        }
        if (pendingEvents.length === 0 && hasCapacity()) {
          scheduleHeartbeat();
          schedulePoll();
        }
      };

      stop = cleanup;
      if (input.signal?.aborted) {
        finish();
        return;
      }
      if (input.terminalSequence !== undefined && cursor >= input.terminalSequence) {
        finish();
        return;
      }
      input.signal?.addEventListener("abort", finish, { once: true });
      scheduleHeartbeat();
      requestMore = () => {
        if (stopped || !hasCapacity()) return;
        if (pendingEvents.length > 0) {
          emitPendingEvent();
          return;
        }
        scheduleHeartbeat();
        if (polling) return;
        if (!hasPolled) {
          hasPolled = true;
          return poll();
        }
        schedulePoll();
      };
    },
    pull() {
      return requestMore?.();
    },
    cancel() {
      stop?.();
    },
  });
}

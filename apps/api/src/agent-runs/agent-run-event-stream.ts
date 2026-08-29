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
  let stop: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const clearTimers = () => {
        if (pollTimer) clearTimeout(pollTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        pollTimer = undefined;
        heartbeatTimer = undefined;
      };
      const cleanup = () => {
        if (stopped) return;
        stopped = true;
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
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(() => {
          if (stopped) return;
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          scheduleHeartbeat();
        }, HEARTBEAT_INTERVAL_MS);
      };
      const schedulePoll = () => {
        if (stopped) return;
        pollTimer = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
      };
      const poll = async () => {
        if (stopped || polling) return;
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
          for (const event of events) {
            if (stopped || event.sequence <= cursor) continue;
            const sse = AgentRunSseEventSchema.parse({
              id: String(event.sequence),
              event: event.eventType,
              data: event.data,
            });
            controller.enqueue(encoder.encode(`id: ${sse.id}\nevent: ${sse.event}\ndata: ${JSON.stringify(sse.data)}\n\n`));
            cursor = event.sequence;
            scheduleHeartbeat();
            if (terminalEvents.has(event.eventType)) {
              finish();
              return;
            }
          }
        } catch (error) {
          fail(error);
          return;
        } finally {
          polling = false;
        }
        schedulePoll();
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
      void poll();
    },
    cancel() {
      stop?.();
    },
  });
}

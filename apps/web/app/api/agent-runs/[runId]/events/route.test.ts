import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openAgentRunEventStream: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { openAgentRunEventStream: mocks.openAgentRunEventStream } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());
const runId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const context = (value: string) => ({ params: Promise.resolve({ runId: value }) });

it("缺失会话返回 401，无效运行 UUID 返回 404", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(GET(new Request(`http://localhost/api/agent-runs/${runId}/events`), context(runId))).resolves.toMatchObject({ status: 401 });
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(GET(new Request("http://localhost/api/agent-runs/not-a-uuid/events"), context("not-a-uuid"))).resolves.toMatchObject({ status: 404 });
  expect(mocks.openAgentRunEventStream).not.toHaveBeenCalled();
});

it("直接透传上游 ReadableStream、SSE headers、游标与取消信号", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  mocks.openAgentRunEventStream.mockResolvedValue(new Response(body, {
    status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" },
  }));
  const abort = new AbortController();
  const request = new Request(`http://localhost/api/agent-runs/${runId}/events?afterEventId=2`, {
    headers: { "last-event-id": "3" }, signal: abort.signal,
  });

  const response = await GET(request, context(runId));

  expect(response.status).toBe(200);
  expect(response.body).toBe(body);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(response.headers.get("connection")).toBe("keep-alive");
  expect(mocks.openAgentRunEventStream).toHaveBeenCalledWith("a".repeat(43), runId, {
    lastEventId: "3", afterEventId: "2", signal: request.signal,
  });
  await response.body!.cancel("browser disconnected");
  expect(cancel).toHaveBeenCalledWith("browser disconnected");
});

it("下游 request abort 会通过传入的 signal 取消上游流", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  mocks.openAgentRunEventStream.mockImplementation(async (_token, _runId, options) => {
    options.signal.addEventListener("abort", () => { void body.cancel("request aborted"); }, { once: true });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const abort = new AbortController();
  const request = new Request(`http://localhost/api/agent-runs/${runId}/events`, { signal: abort.signal });
  await GET(request, context(runId));

  abort.abort();

  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("request aborted"));
});

it("把上游鉴权和所有权失败收敛为相同安全状态", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.openAgentRunEventStream.mockRejectedValueOnce({ status: 401 }).mockRejectedValueOnce({ status: 404 });
  await expect(GET(new Request(`http://localhost/api/agent-runs/${runId}/events`), context(runId))).resolves.toMatchObject({ status: 401 });
  await expect(GET(new Request(`http://localhost/api/agent-runs/${runId}/events`), context(runId))).resolves.toMatchObject({ status: 404 });
});

it("上游无响应体故障稳定收敛为无缓存 502", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.openAgentRunEventStream.mockRejectedValue({ status: 503 });

  const response = await GET(new Request(`http://localhost/api/agent-runs/${runId}/events`), context(runId));

  expect(response.status).toBe(502);
  expect(response.body).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
});

import { createServer } from "node:http";

export const fakeAnysearchPublicJobPhase = "fake-anysearch-public-job-v1";

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/** 仅供版本化 E2E phase 使用；不记录请求正文、鉴权或用户事实。 */
export function startFakeAnysearchFixtureServer({ host = "127.0.0.1", port = 39334, signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Fake AnySearch fixture 已取消"));
  const server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "FIXTURE_ROUTE_NOT_CONFIGURED" }));
  });
  let closePromise;
  const stop = () => {
    if (closePromise) return closePromise;
    signal?.removeEventListener("abort", onAbort);
    closePromise = close(server);
    return closePromise;
  };
  const onAbort = () => { void stop(); };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      signal?.addEventListener("abort", onAbort, { once: true });
      resolve({ origin: "http://" + host + ":" + port, close: stop });
    });
  });
}

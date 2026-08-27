import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRuntimeConfig, prepareInfrastructure, runRuntime, startApplications } from "./local-runtime.mjs";

function createControlledChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.sentSignal = signal;
    return true;
  };
  return child;
}

test("database package exposes the documented db:migrate command", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../packages/database/package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.scripts["db:migrate"], "drizzle-kit migrate --config=drizzle.config.ts");
});

test("runtime tests run without Node's subprocess wrapper to avoid IPC serialization failures", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.scripts["test:runtime"], "node scripts/local-runtime.test.mjs");
});

test("local runtime migrates before starting applications", async () => {
  const events = [];
  const child = createControlledChild();
  const runtime = runRuntime({
    config: createRuntimeConfig({ env: {} }),
    signalSource: new EventEmitter(),
    prepare: async () => events.push("prepare"),
    migrate: async () => events.push("migrate"),
    start: () => {
      events.push("start");
      return child;
    },
    waitForReady: async () => events.push("ready"),
    cleanup: async () => events.push("cleanup"),
  });

  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 0, null);

  assert.deepEqual(await runtime, { exitCode: 0 });
  assert.deepEqual(events, ["prepare", "migrate", "start", "ready", "cleanup"]);
});

test("a local migration failure prevents application startup", async () => {
  let started = false;
  const error = await runRuntime({
    config: createRuntimeConfig({ env: {} }),
    signalSource: new EventEmitter(),
    prepare: async () => {},
    migrate: async () => { throw new Error("migration failure"); },
    start: () => {
      started = true;
      throw new Error("applications started");
    },
    cleanup: async () => {},
  }).then(
    () => null,
    (reason) => reason,
  );

  assert.match(error?.message ?? "", /migration failure/);
  assert.equal(started, false);
});

test("Playwright delegates isolated cleanup to the local runtime", async () => {
  const config = await readFile(new URL("../apps/web/playwright.config.ts", import.meta.url), "utf8");

  assert.doesNotMatch(config, /globalTeardown:/);
  assert.match(config, /command: "node scripts\/local-runtime\.mjs --test"/);
});

test("starts compose and waits for healthy dependencies before applications", async () => {
  const calls = [];
  await prepareInfrastructure({
    run: async (command, args) => calls.push([command, ...args]),
  });

  assert.deepEqual(calls, [
    ["docker", "compose", "version"],
    ["docker", "compose", "up", "-d", "--wait", "postgres", "redis", "minio", "mailpit"],
    ["docker", "compose", "up", "-d", "minio-init"],
    ["docker", "compose", "wait", "minio-init"],
  ]);
});

test("stops before applications when compose is unavailable", async () => {
  await assert.rejects(
    prepareInfrastructure({ run: async () => { throw new Error("docker missing"); } }),
    /Docker Compose 不可用/,
  );
});

test("forces local Dev Auth when spawning applications", () => {
  let spawnCall;
  startApplications({
    env: {
      APP_ENV: "production",
      AUTH_MODE: "password",
      DEV_AUTH_SHARED_SECRET: "existing-secret",
      WEB_PORT: "4020",
      API_PORT: "4021",
      UNRELATED_VALUE: "preserved",
    },
    spawnProcess: (...args) => {
      spawnCall = args;
      return {};
    },
  });

  const [command, args, options] = spawnCall;
  assert.equal(command, "pnpm");
  assert.deepEqual(args, ["--parallel", "--stream", "--filter", "web", "--filter", "api", "--filter", "worker", "dev"]);
  assert.equal(options.env.APP_ENV, "local");
  assert.equal(options.env.AUTH_MODE, "dev");
  assert.equal(options.env.DEV_AUTH_SHARED_SECRET, "existing-secret");
  assert.equal(options.env.PORT, "4020");
  assert.equal(options.env.API_PORT, "4021");
  assert.equal(options.detached, false);
  assert.equal(options.env.UNRELATED_VALUE, "preserved");
});

test("test runtime removes only its isolated Compose project before starting dependencies", async () => {
  const calls = [];
  const processOptions = [];
  const runtime = createRuntimeConfig({ test: true });

  await prepareInfrastructure({
    config: runtime,
    run: async (command, args, options) => {
      calls.push([command, ...args, options.env.POSTGRES_PORT]);
      processOptions.push(options);
    },
  });

  assert.equal(runtime.appEnv, "test");
  assert.equal(runtime.composeProject, "job-copilot-issue-2-e2e");
  assert.equal(runtime.webPort, "3120");
  assert.equal(runtime.apiPort, "3121");
  assert.ok(processOptions.every((options) => options.env.PATH === process.env.PATH));
  assert.deepEqual(calls, [
    ["docker", "compose", "version", "55420"],
    ["docker", "compose", "--project-name", "job-copilot-issue-2-e2e", "down", "-v", "--remove-orphans", "55420"],
    ["docker", "compose", "--project-name", "job-copilot-issue-2-e2e", "up", "-d", "--wait", "postgres", "redis", "minio", "mailpit", "55420"],
    ["docker", "compose", "--project-name", "job-copilot-issue-2-e2e", "up", "-d", "minio-init", "55420"],
    ["docker", "compose", "--project-name", "job-copilot-issue-2-e2e", "wait", "minio-init", "55420"],
  ]);
});

test("test runtime passes its isolated service addresses to every application", () => {
  let spawnCall;
  const runtime = createRuntimeConfig({ test: true });

  startApplications({
    config: runtime,
    env: { UNRELATED_VALUE: "preserved" },
    spawnProcess: (...args) => {
      spawnCall = args;
      return {};
    },
  });

  const [command, args, options] = spawnCall;
  assert.equal(options.env.APP_ENV, "test");
  assert.equal(options.env.PORT, "3120");
  assert.equal(options.env.API_PORT, "3121");
  assert.equal(options.env.API_INTERNAL_URL, "http://127.0.0.1:3121");
  assert.equal(options.env.DATABASE_URL, "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot");
  assert.equal(options.env.REDIS_URL, "redis://127.0.0.1:64790");
  assert.equal(options.env.MINIO_ENDPOINT, "http://127.0.0.1:59100");
  assert.equal(options.env.MINIO_ACCESS_KEY, "job_copilot");
  assert.equal(options.env.MINIO_SECRET_KEY, "local_only_job_copilot_secret");
  assert.equal(options.env.MINIO_BUCKET, "career-documents");
  assert.equal(options.env.MAILPIT_ENDPOINT, "http://127.0.0.1:58126");
  assert.equal(options.env.DEV_AUTH_SHARED_SECRET, "issue-2-e2e-dev-auth-shared-secret");
  assert.match(options.env.NODE_OPTIONS, /--import=tsx/);
  assert.equal(options.env.UNRELATED_VALUE, "preserved");
  assert.doesNotMatch(JSON.stringify([command, args]), /local_only_job_copilot_secret/);
});

test("signal waits for the controlled application child before isolated cleanup", async () => {
  const events = [];
  const signalSource = new EventEmitter();
  const child = createControlledChild();
  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true }),
    signalSource,
    prepare: async () => events.push("prepare"),
    migrate: async () => events.push("migrate"),
    start: () => {
      events.push("start");
      return child;
    },
    waitForReady: async () => events.push("ready"),
    cleanup: async () => events.push("cleanup"),
  });

  await new Promise((resolve) => setImmediate(resolve));
  signalSource.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["prepare", "migrate", "start", "ready"]);
  assert.equal(child.sentSignal, "SIGTERM");

  child.emit("exit", 0, null);
  assert.deepEqual(await runtime, { exitCode: 143 });
  assert.deepEqual(events, ["prepare", "migrate", "start", "ready", "cleanup"]);
});

test("a startup signal aborts and settles pending readiness before cleanup", async () => {
  const events = [];
  const signalSource = new EventEmitter();
  const child = createControlledChild();
  let readinessSignal;
  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true }),
    signalSource,
    prepare: async () => events.push("prepare"),
    migrate: async () => events.push("migrate"),
    start: () => {
      events.push("start");
      return child;
    },
    waitForReady: ({ signal }) => new Promise((resolve, reject) => {
      readinessSignal = signal;
      events.push("waiting");
      signal.addEventListener("abort", () => {
        events.push("readiness-aborted");
        reject(signal.reason);
      }, { once: true });
    }),
    cleanup: async () => events.push("cleanup"),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readinessSignal.aborted, false);

  signalSource.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(readinessSignal.aborted, true);
  assert.equal(child.sentSignal, "SIGINT");
  assert.deepEqual(events, ["prepare", "migrate", "start", "waiting", "readiness-aborted"]);

  child.emit("exit", 0, null);
  assert.deepEqual(await runtime, { exitCode: 130 });
  assert.deepEqual(events, ["prepare", "migrate", "start", "waiting", "readiness-aborted", "cleanup"]);
});

test("the default readiness wiring forwards startup signals to fetch", async () => {
  const signalSource = new EventEmitter();
  const child = createControlledChild();
  let fetchSignal;
  let fetchCanSucceed = false;
  let rejectFetch;
  let resolveFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  const fetchImpl = (_url, { signal } = {}) => {
    if (fetchCanSucceed) {
      return Promise.resolve({ ok: true });
    }
    fetchSignal = signal;
    resolveFetchStarted();
    return new Promise((_resolve, reject) => {
      rejectFetch = reject;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };

  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true }),
    signalSource,
    prepare: async () => {},
    migrate: async () => {},
    start: () => child,
    fetchImpl,
    cleanup: async () => {},
  });
  child.kill = (signal) => {
    child.killed = true;
    child.sentSignal = signal;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };

  try {
    await fetchStarted;
    signalSource.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fetchSignal?.aborted, true);
    assert.equal(child.sentSignal, "SIGTERM");

    assert.deepEqual(await runtime, { exitCode: 143 });
  } finally {
    fetchCanSucceed = true;
    rejectFetch?.(new Error("test cleanup"));
    await runtime.catch(() => {});
  }
});

test("a child exiting cleanly before readiness fails with exit code 1", async () => {
  const child = createControlledChild();
  let readinessSignal;
  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true }),
    signalSource: new EventEmitter(),
    prepare: async () => {},
    migrate: async () => {},
    start: () => child,
    waitForReady: ({ signal }) => new Promise((resolve, reject) => {
      readinessSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    cleanup: async () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 0, null);

  await assert.rejects(runtime, (error) => error.exitCode === 1);
  assert.equal(readinessSignal.aborted, true);
});

test("a ready application child exiting nonzero fails after isolated cleanup", async () => {
  const events = [];
  const child = createControlledChild();
  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true }),
    signalSource: new EventEmitter(),
    prepare: async () => events.push("prepare"),
    migrate: async () => events.push("migrate"),
    start: () => child,
    waitForReady: async () => events.push("ready"),
    cleanup: async () => events.push("cleanup"),
  });

  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 7, null);

  await assert.rejects(runtime, (error) => error.exitCode === 7);
  assert.deepEqual(events, ["prepare", "migrate", "ready", "cleanup"]);
});

test("a ready application child terminated by a signal fails with that signal exit code", async () => {
  const child = createControlledChild();
  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true }),
    signalSource: new EventEmitter(),
    prepare: async () => {},
    migrate: async () => {},
    start: () => child,
    waitForReady: async () => {},
    cleanup: async () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", null, "SIGTERM");

  await assert.rejects(runtime, (error) => error.exitCode === 143);
});

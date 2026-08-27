import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createNestDevCommand, runNestDev } from "./nest-dev.mjs";
import { createRuntimeConfig, prepareInfrastructure, runRuntime, startApplications } from "./local-runtime.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const nestDevPath = fileURLToPath(new URL("./nest-dev.mjs", import.meta.url));
const controlledNestChildPath = fileURLToPath(new URL("./fixtures/nest-dev-controlled-child.mjs", import.meta.url));

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

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw new Error(`timed out waiting for ${path}`);
}

async function startControlledNestDev({ mode, exitCode } = {}) {
  const cwd = await mkdtemp(join(repositoryRoot, ".nest-dev-test-"));
  const nestCliPath = join(cwd, "node_modules/@nestjs/cli/bin/nest.js");
  const pidPath = join(cwd, "child.pid");
  const readyPath = join(cwd, "child.ready");
  const signalPath = join(cwd, "child.signal");
  await mkdir(join(cwd, "node_modules/@nestjs/cli/bin"), { recursive: true });
  await copyFile(controlledNestChildPath, nestCliPath);

  const launcher = spawn(process.execPath, [nestDevPath], {
    cwd,
    env: {
      ...process.env,
      NEST_DEV_TEST_EXIT_CODE: String(exitCode ?? 0),
      NEST_DEV_TEST_MODE: mode ?? "wait-for-signal",
      NEST_DEV_TEST_PID_FILE: pidPath,
      NEST_DEV_TEST_READY_FILE: readyPath,
      NEST_DEV_TEST_SIGNAL_FILE: signalPath,
    },
    stdio: "ignore",
  });
  const exit = waitForExit(launcher);

  return {
    cwd,
    exit,
    launcher,
    pidPath,
    readyPath,
    signalPath,
    dispose: () => rm(cwd, { force: true, recursive: true }),
  };
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

test("forces local Dev Auth and preserves caller Node options when spawning applications", () => {
  let spawnCall;
  startApplications({
    env: {
      APP_ENV: "production",
      AUTH_MODE: "password",
      DEV_AUTH_SHARED_SECRET: "existing-secret",
      NODE_OPTIONS: "--trace-warnings",
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
  assert.equal(options.env.NODE_OPTIONS, "--trace-warnings");
  assert.equal(options.detached, false);
  assert.equal(options.env.UNRELATED_VALUE, "preserved");
});

test("API and Worker dev commands launch the cross-platform Nest loader", async () => {
  for (const packagePath of ["../apps/api/package.json", "../apps/worker/package.json"]) {
    const packageJson = JSON.parse(await readFile(new URL(packagePath, import.meta.url), "utf8"));

    assert.equal(packageJson.scripts.dev, "node ../../scripts/nest-dev.mjs");
    assert.doesNotMatch(packageJson.scripts.dev, /NODE_OPTIONS=/);
  }
});

test("Nest dev loader explicitly imports tsx and preserves existing Node options for watch children", () => {
  const command = createNestDevCommand({
    cwd: "/workspace/apps/api",
    nodeExecutable: "node",
    env: { NODE_OPTIONS: "--trace-warnings" },
  });

  assert.deepEqual(command.args, [
    "--import=tsx",
    "/workspace/apps/api/node_modules/@nestjs/cli/bin/nest.js",
    "start",
    "--watch",
  ]);
  assert.equal(command.env.NODE_OPTIONS, "--trace-warnings --import=tsx");
});

test("Nest dev loader appends the root tsx loader only when NODE_OPTIONS lacks that exact import", () => {
  const nestedLoader = createNestDevCommand({
    env: { NODE_OPTIONS: "--trace-warnings --import=tsx/cjs" },
  });
  assert.equal(nestedLoader.env.NODE_OPTIONS, "--trace-warnings --import=tsx/cjs --import=tsx");

  for (const nodeOptions of ["--trace-warnings --import=tsx", "--trace-warnings --import tsx", "--import 'tsx'"]) {
    const command = createNestDevCommand({ env: { NODE_OPTIONS: nodeOptions } });
    assert.equal(command.env.NODE_OPTIONS, nodeOptions);
  }
});

test("Nest dev launcher forwards SIGTERM and SIGINT once, waits for the child, and leaves no orphan", async () => {
  for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const fixture = await startControlledNestDev();
    try {
      const childPid = Number(await waitForFile(fixture.pidPath));
      await waitForFile(fixture.readyPath);
      fixture.launcher.kill(signal);
      fixture.launcher.kill(signal);

      assert.deepEqual(await fixture.exit, { code: exitCode, signal: null });
      assert.equal(await readFile(fixture.signalPath, "utf8"), `${signal}\n`);
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    } finally {
      await fixture.dispose();
    }
  }
});

test("Nest dev launcher preserves normal child exit codes and child signal exit semantics", async () => {
  const normal = await startControlledNestDev({ mode: "exit", exitCode: 17 });
  try {
    assert.deepEqual(await normal.exit, { code: 17, signal: null });
  } finally {
    await normal.dispose();
  }

  const signaled = await startControlledNestDev({ mode: "self-signal" });
  try {
    const childPid = Number(await waitForFile(signaled.pidPath));
    assert.deepEqual(await signaled.exit, { code: 143, signal: null });
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    await signaled.dispose();
  }
});

test("Nest dev launcher converts every child signal to its conventional exit code and removes signal handlers", async () => {
  const signalSource = new EventEmitter();
  const child = createControlledChild();
  const exitCode = runNestDev({
    command: createNestDevCommand({ env: {} }),
    signalSource,
    spawnProcess: () => child,
  });

  child.emit("exit", null, "SIGHUP");

  assert.equal(await exitCode, 129);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("Nest dev launcher settles real spawn failures and removes signal handlers", async () => {
  const signalSource = new EventEmitter();
  const exitCode = await runNestDev({
    command: { nodeExecutable: "/definitely-not-a-node-executable", args: [], env: {} },
    signalSource,
  });

  assert.equal(exitCode, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
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
  assert.equal(options.env.NODE_OPTIONS, undefined);
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

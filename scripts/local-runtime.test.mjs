import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createNestDevCommand, runNestDev } from "./nest-dev.mjs";
import { createRuntimeConfig, prepareInfrastructure, runRuntime, startApplications } from "./local-runtime.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const nestDevPath = fileURLToPath(new URL("./nest-dev.mjs", import.meta.url));
const controlledNestChildPath = fileURLToPath(new URL("./fixtures/nest-dev-controlled-child.mjs", import.meta.url));
const killFalseProbePath = fileURLToPath(new URL("./fixtures/nest-dev-kill-false-probe.mjs", import.meta.url));
const posixOnly = process.platform === "win32";

function createControlledChild({ killResult = true } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.killed = false;
  child.sentSignals = [];
  child.kill = (signal) => {
    child.killed = true;
    child.sentSignal = signal;
    child.sentSignals.push(signal);
    return killResult;
  };
  return child;
}

function createFakeTimers() {
  const pending = new Map();
  let nextId = 0;

  return {
    clearTimeout: (id) => pending.delete(id),
    get pendingCount() {
      return pending.size;
    },
    runNext: () => {
      const next = pending.entries().next().value;
      if (!next) throw new Error("no pending timer");
      const [id, callback] = next;
      pending.delete(id);
      callback();
    },
    setTimeout: (callback) => {
      const id = ++nextId;
      pending.set(id, callback);
      return id;
    },
  };
}

function createDeadlineChild({ sigkill } = {}) {
  const child = createControlledChild();
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls += 1; };
  child.kill = (signal) => {
    child.killed = true;
    child.sentSignal = signal;
    child.sentSignals.push(signal);
    return signal === "SIGKILL" ? sigkill() : true;
  };
  return child;
}

function assertShutdownCleanup({ child, signalSource, timers }) {
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.unrefCalls, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(timers.pendingCount, 0);
}

function waitForExit(child, deadlineMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for child exit"));
    }, deadlineMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForFile(path, deadlineMs = 1_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(path, "utf8");
      if (contents.trim()) return contents;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`timed out waiting for ${path}`);
}

async function startControlledNestDev({ mode, exitCode } = {}) {
  const cwd = await mkdtemp(join(repositoryRoot, ".nest-dev-test-"));
  const entryPath = join(cwd, "src/main.ts");
  const pidPath = join(cwd, "child.pid");
  const readyPath = join(cwd, "child.ready");
  const signalPath = join(cwd, "child.signal");
  await mkdir(join(cwd, "src"), { recursive: true });
  await copyFile(controlledNestChildPath, entryPath);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));

  const launcher = spawn(process.execPath, [nestDevPath], {
    cwd,
    env: {
      ...process.env,
      LOCAL_E2E_NEST_TS_ENTRY: "1",
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
    dispose: async () => {
      const childPid = Number(await readFile(pidPath, "utf8").catch(() => ""));
      try {
        if (launcher.exitCode === null && launcher.signalCode === null) {
          try {
            launcher.kill("SIGTERM");
            await exit;
          } catch {
            try {
              const forcedExit = waitForExit(launcher, 250);
              launcher.kill("SIGKILL");
              await forcedExit;
            } catch {
              // Child PID cleanup below still runs after any launcher timeout or error.
            }
          }
        }
      } finally {
        try {
          if (Number.isInteger(childPid) && childPid > 0) {
            try {
              process.kill(childPid, 0);
              process.kill(childPid, "SIGKILL");
            } catch (error) {
              if (error?.code !== "ESRCH") throw error;
            }
          }
        } finally {
          await rm(cwd, { force: true, recursive: true });
        }
      }
    },
  };
}

async function startKillFalseProbe() {
  const cwd = await mkdtemp(join(repositoryRoot, ".nest-dev-test-"));
  const pidPath = join(cwd, "child.pid");
  const readyPath = join(cwd, "child.ready");
  const launcher = spawn(process.execPath, [killFalseProbePath], {
    cwd,
    env: {
      ...process.env,
      NEST_DEV_TEST_PID_FILE: pidPath,
      NEST_DEV_TEST_READY_FILE: readyPath,
      NEST_DEV_TEST_SHUTDOWN_TIMEOUT_MS: "10",
      NEST_DEV_TEST_SHUTDOWN_CLOSE_TIMEOUT_MS: "10",
    },
    stdio: "ignore",
  });
  const exit = waitForExit(launcher, 1_000);

  return {
    cwd,
    exit,
    launcher,
    pidPath,
    readyPath,
    dispose: async () => {
      const childPid = Number(await readFile(pidPath, "utf8").catch(() => ""));
      try {
        if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
        await exit.catch(() => {});
      } finally {
        try {
          if (Number.isInteger(childPid) && childPid > 0) process.kill(childPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        } finally {
          await rm(cwd, { force: true, recursive: true });
        }
      }
    },
  };
}

test("database package exposes the documented db:migrate command", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../packages/database/package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.scripts["db:migrate"], "drizzle-kit migrate --config=drizzle.config.ts");
});

test("Nest application tests exclude compiled artifacts", async () => {
  for (const app of ["api", "worker"]) {
    const packageJson = JSON.parse(await readFile(new URL(`../apps/${app}/package.json`, import.meta.url), "utf8"));
    assert.match(packageJson.scripts.test, /--exclude=dist\/\*\*/);
  }
});

test("runtime tests run without Node's subprocess wrapper to avoid IPC serialization failures", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.scripts["test:runtime"], "node scripts/local-runtime.test.mjs");
});

test("Web typecheck generates Next route types before compiling", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../apps/web/package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.scripts.typecheck, "next typegen && tsc --noEmit");
});

test("direct Nest dev entry force-exits after runNestDev settles", async () => {
  const launcher = await readFile(nestDevPath, "utf8");

  assert.match(launcher, /process\.exit\(await runNestDev\(\)\);/);
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

test("本地运行时在迁移后直接启动应用，不预构建 API 与 Worker", async () => {
  const events = [];
  const child = createControlledChild();
  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true }),
    signalSource: new EventEmitter(),
    prepare: async () => events.push("prepare"),
    migrate: async () => events.push("migrate"),
    build: async () => { throw new Error("不应预构建应用入口"); },
    start: () => { events.push("start"); return child; },
    waitForReady: async () => events.push("ready"),
    cleanup: async () => events.push("cleanup"),
  });

  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 0, null);
  await runtime;
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

test("Playwright config 仅将版本化 Fake AnySearch phase 交给本地测试运行时", async () => {
  const config = await readFile(new URL("../apps/web/playwright.config.ts", import.meta.url), "utf8");

  assert.match(config, /E2E_ANYSEARCH_PUBLIC_JOB_PHASE/);
  assert.match(config, /fake-anysearch-test-phase-policy/);
  assert.match(config, /anysearch-public-job-discovery/);
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

test("test runtime 清除任意 OPENAI_ 前缀变量后再启动 Web、API 与 Worker", () => {
  let spawnCall;
  startApplications({
    config: createRuntimeConfig({ test: true, env: { OPENAI_UNDOCUMENTED_SENTINEL: "must-not-reach-child" } }),
    env: { OPENAI_UNDOCUMENTED_SENTINEL: "must-not-reach-child" },
    spawnProcess: (...args) => { spawnCall = args; return {}; },
  });
  assert.equal(spawnCall[2].env.OPENAI_UNDOCUMENTED_SENTINEL, undefined);
});

test("API and Worker dev commands launch the cross-platform Nest loader", async () => {
  for (const packagePath of ["../apps/api/package.json", "../apps/worker/package.json"]) {
    const packageJson = JSON.parse(await readFile(new URL(packagePath, import.meta.url), "utf8"));

    assert.equal(packageJson.scripts.dev, "node ../../scripts/nest-dev.mjs");
    assert.doesNotMatch(packageJson.scripts.dev, /NODE_OPTIONS=/);
  }
});

test("普通 Nest 开发保持 CLI 监督；仅 local E2E runtime 直接 watch TypeScript 入口", () => {
  for (const cwd of ["/workspace/apps/api", "/workspace/apps/worker"]) {
    const command = createNestDevCommand({ cwd, nodeExecutable: "node", env: {} });
    assert.deepEqual(command, {
      nodeExecutable: "node",
      args: ["--import=tsx", `${cwd}/node_modules/@nestjs/cli/bin/nest.js`, "start", "--watch"],
      env: { NODE_OPTIONS: "--import=tsx" },
    });
    assert.deepEqual(createNestDevCommand({ cwd, nodeExecutable: "node", env: { LOCAL_E2E_NEST_TS_ENTRY: "1" } }).args, ["--import=tsx", "--watch", `${cwd}/src/main.ts`]);
  }
});

test("Nest dev loader explicitly imports tsx and preserves existing Node options for watch children", () => {
  const command = createNestDevCommand({
    cwd: "/workspace/apps/api",
    nodeExecutable: "node",
    env: { NODE_OPTIONS: "--trace-warnings" },
  });

  assert.deepEqual(command.args, ["--import=tsx", "/workspace/apps/api/node_modules/@nestjs/cli/bin/nest.js", "start", "--watch"]);
  assert.equal(command.env.NODE_OPTIONS, "--trace-warnings --import=tsx");
});

test("Nest dev loader appends the root tsx loader only when NODE_OPTIONS lacks that exact import", () => {
  const nestedLoader = createNestDevCommand({
    env: { NODE_OPTIONS: "--trace-warnings --import=tsx/cjs" },
  });
  assert.equal(nestedLoader.env.NODE_OPTIONS, "--trace-warnings --import=tsx/cjs --import=tsx");

  for (const nodeOptions of ["--trace-warnings --import=tsx", "--trace-warnings --import tsx", "--import \"tsx\""]) {
    const command = createNestDevCommand({ env: { NODE_OPTIONS: nodeOptions } });
    assert.equal(command.env.NODE_OPTIONS, nodeOptions);
  }

  const invalidQuote = createNestDevCommand({ env: { NODE_OPTIONS: "--import 'tsx" } });
  assert.equal(invalidQuote.env.NODE_OPTIONS, "--import 'tsx --import=tsx");

  const singleQuote = createNestDevCommand({ env: { NODE_OPTIONS: "--import 'tsx'" } });
  assert.equal(singleQuote.env.NODE_OPTIONS, "--import 'tsx' --import=tsx");
});

test("Nest dev launcher forwards each real SIGTERM and SIGINT, waits for the child, and leaves no orphan", { skip: posixOnly }, async () => {
  for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const fixture = await startControlledNestDev();
    try {
      const childPid = Number(await waitForFile(fixture.pidPath));
      await waitForFile(fixture.readyPath);
      fixture.launcher.kill(signal);

      assert.deepEqual(await fixture.exit, { code: exitCode, signal: null });
      assert.equal(await readFile(fixture.signalPath, "utf8"), `${signal}\n`);
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    } finally {
      await fixture.dispose();
    }
  }
});

test("Nest dev launcher forwards repeated deterministic signals only once", async () => {
  const signalSource = new EventEmitter();
  const child = createControlledChild();
  const exitCode = runNestDev({
    command: createNestDevCommand({ env: {} }),
    signalSource,
    spawnProcess: () => child,
  });

  signalSource.emit("SIGTERM", "SIGTERM");
  signalSource.emit("SIGINT", "SIGINT");
  assert.deepEqual(child.sentSignals, ["SIGTERM"]);

  child.emit("exit", 0, null);
  assert.equal(await exitCode, 143);
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

test("Nest dev launcher preserves child exits after a failed signal delivery", async () => {
  for (const [code, signal, expected] of [[0, null, 0], [null, "SIGHUP", 129]]) {
    const signalSource = new EventEmitter();
    const child = createControlledChild({ killResult: false });
    const exitCode = runNestDev({
      command: createNestDevCommand({ env: {} }),
      signalSource,
      spawnProcess: () => child,
      shutdownTimeoutMs: 10,
    });

    signalSource.emit("SIGTERM", "SIGTERM");
    child.emit("exit", code, signal);

    assert.equal(await exitCode, expected);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  }
});

test("Nest dev launcher bounds failed signal delivery without an exit event", async () => {
  const signalSource = new EventEmitter();
  const child = createControlledChild({ killResult: false });
  const exitCode = runNestDev({
    command: createNestDevCommand({ env: {} }),
    signalSource,
    spawnProcess: () => child,
    shutdownTimeoutMs: 10,
  });

  signalSource.emit("SIGTERM", "SIGTERM");

  assert.equal(await exitCode, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("Nest dev launcher settles immediately when deadline SIGKILL fails", async () => {
  for (const sigkill of [() => false, () => { throw new Error("SIGKILL failed"); }]) {
    const signalSource = new EventEmitter();
    const timers = createFakeTimers();
    const child = createDeadlineChild({ sigkill });
    const exitCode = runNestDev({
      command: createNestDevCommand({ env: {} }),
      signalSource,
      spawnProcess: () => child,
      shutdownTimeoutMs: 1,
      timers,
    });

    signalSource.emit("SIGTERM", "SIGTERM");
    assert.equal(timers.pendingCount, 1);
    timers.runNext();

    assert.equal(await exitCode, 1);
    assert.deepEqual(child.sentSignals, ["SIGTERM", "SIGKILL"]);
    assertShutdownCleanup({ child, signalSource, timers });
  }
});

test("Nest dev launcher needs its second deadline when SIGKILL does not close the child", async () => {
  const signalSource = new EventEmitter();
  const timers = createFakeTimers();
  const child = createDeadlineChild({ sigkill: () => true });
  const exitCode = runNestDev({
    command: createNestDevCommand({ env: {} }),
    signalSource,
    spawnProcess: () => child,
    shutdownTimeoutMs: 1,
    shutdownCloseTimeoutMs: 1,
    timers,
  });
  let settled = false;
  void exitCode.then(() => { settled = true; });

  signalSource.emit("SIGTERM", "SIGTERM");
  timers.runNext();
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(timers.pendingCount, 1);
  timers.runNext();

  assert.equal(await exitCode, 1);
  assertShutdownCleanup({ child, signalSource, timers });
});

test("Nest dev launcher preserves the forwarded signal when SIGKILL closes in its close window", async () => {
  const signalSource = new EventEmitter();
  const timers = createFakeTimers();
  const child = createDeadlineChild({ sigkill: () => true });
  const exitCode = runNestDev({
    command: createNestDevCommand({ env: {} }),
    signalSource,
    spawnProcess: () => child,
    shutdownTimeoutMs: 1,
    shutdownCloseTimeoutMs: 1,
    timers,
  });

  signalSource.emit("SIGTERM", "SIGTERM");
  timers.runNext();
  child.emit("exit", null, "SIGKILL");

  assert.equal(await exitCode, 143);
  assertShutdownCleanup({ child, signalSource, timers });
});

test("Nest dev launcher does not schedule a close deadline after synchronous SIGKILL exit", async () => {
  const signalSource = new EventEmitter();
  const timers = createFakeTimers();
  const child = createDeadlineChild({
    sigkill: () => {
      child.emit("exit", null, "SIGKILL");
      return true;
    },
  });
  const exitCode = runNestDev({
    command: createNestDevCommand({ env: {} }),
    signalSource,
    spawnProcess: () => child,
    shutdownTimeoutMs: 1,
    shutdownCloseTimeoutMs: 1,
    timers,
  });

  signalSource.emit("SIGTERM", "SIGTERM");
  timers.runNext();

  assert.equal(await exitCode, 143);
  assertShutdownCleanup({ child, signalSource, timers });
});

test("direct Nest dev entry force-exits after a bounded kill(false) deadline", { skip: posixOnly }, async () => {
  const fixture = await startKillFalseProbe();
  try {
    const childPid = Number(await waitForFile(fixture.pidPath));
    await waitForFile(fixture.readyPath);
    fixture.launcher.kill("SIGTERM");

    assert.deepEqual(await fixture.exit, { code: 1, signal: null });
    assert.doesNotThrow(() => process.kill(childPid, 0));
  } finally {
    await fixture.dispose();
  }
});

test("Nest dev launcher waits for a child exiting after an error during signal delivery", async () => {
  const signalSource = new EventEmitter();
  const child = createControlledChild();
  child.kill = (signal) => {
    child.sentSignals.push(signal);
    queueMicrotask(() => child.emit("error", new Error("kill error")));
    return true;
  };
  const exitCode = runNestDev({
    command: createNestDevCommand({ env: {} }),
    signalSource,
    spawnProcess: () => child,
    shutdownTimeoutMs: 50,
  });

  signalSource.emit("SIGTERM", "SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.sentSignals, ["SIGTERM"]);
  assert.equal(signalSource.listenerCount("SIGINT"), 1);
  assert.equal(signalSource.listenerCount("SIGTERM"), 1);

  child.emit("exit", 0, null);
  assert.equal(await exitCode, 143);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("Nest dev launcher stops a running child after a runtime error before settling", async () => {
  const signalSource = new EventEmitter();
  const child = createControlledChild();
  const exitCode = runNestDev({
    command: createNestDevCommand({ env: {} }),
    signalSource,
    spawnProcess: () => child,
    shutdownTimeoutMs: 50,
  });

  child.emit("error", new Error("runtime error"));

  assert.deepEqual(child.sentSignals, ["SIGTERM"]);
  assert.equal(signalSource.listenerCount("SIGINT"), 1);
  assert.equal(signalSource.listenerCount("SIGTERM"), 1);

  child.emit("exit", 0, null);
  assert.equal(await exitCode, 1);
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
  assert.equal(runtime.mailpitSmtpPort, "31125");
  assert.ok(processOptions.every((options) => options.env.PATH === process.env.PATH));
  assert.ok(processOptions.every((options) => options.env.MAILPIT_SMTP_PORT === "31125"));
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
  assert.equal(options.env.PUBLIC_SOURCE_NETWORK_MODE, "disabled");
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

test("版本化 Fake AnySearch phase 在取消时关闭 fixture server，再清理隔离基础设施", async () => {
  const events = [];
  const signalSource = new EventEmitter();
  const child = createControlledChild();
  let fixtureSignal;
  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true, anysearchPublicJobPhase: "fake-anysearch-public-job-v1" }),
    signalSource,
    prepare: async () => events.push("prepare"),
    migrate: async () => events.push("migrate"),
    startFixtureServer: async ({ config, signal }) => {
      fixtureSignal = signal;
      assert.equal(config.anysearchPublicJobPhase, "fake-anysearch-public-job-v1");
      events.push("fixture-start");
      return { close: async () => events.push("fixture-close") };
    },
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
  assert.equal(fixtureSignal?.aborted, true);
  child.emit("exit", 0, null);

  assert.deepEqual(await runtime, { exitCode: 143 });
  assert.deepEqual(events, ["prepare", "migrate", "fixture-start", "start", "ready", "fixture-close", "cleanup"]);
});

test("fixture close 失败仍清理隔离 compose 基础设施", async () => {
  const events = [];
  const child = createControlledChild();
  const runtime = runRuntime({
    config: createRuntimeConfig({ test: true, anysearchPublicJobPhase: "fake-anysearch-public-job-v1" }),
    prepare: async () => events.push("prepare"),
    migrate: async () => events.push("migrate"),
    startFixtureServer: async () => ({ close: async () => { events.push("fixture-close"); throw new Error("fixture close failed"); } }),
    start: () => child,
    waitForReady: async () => undefined,
    cleanup: async () => events.push("cleanup"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 0, null);
  await assert.rejects(runtime, /fixture close failed/);
  assert.deepEqual(events, ["prepare", "migrate", "fixture-close", "cleanup"]);
});

test("版本化 missing-key phase 保留只读 fixture endpoint，但绝不向应用注入 AnySearch key", () => {
  let spawnCall;
  const runtime = createRuntimeConfig({ test: true, anysearchPublicJobPhase: "fake-anysearch-public-job-missing-key-v1" });

  startApplications({
    config: runtime,
    env: { ANYSEARCH_API_KEY: "caller-key-must-not-survive" },
    spawnProcess: (...args) => {
      spawnCall = args;
      return {};
    },
  });

  const [, , options] = spawnCall;
  assert.equal(runtime.anysearchPublicJobPhase, "fake-anysearch-public-job-missing-key-v1");
  assert.equal(options.env.E2E_ANYSEARCH_PUBLIC_JOB_PHASE, "fake-anysearch-public-job-missing-key-v1");
  assert.equal(options.env.ANYSEARCH_BASE_URL, "http://127.0.0.1:39334");
  assert.equal(options.env.JOB_PAGE_FETCHER_TEST_ORIGIN, "http://127.0.0.1:39334");
  assert.equal(options.env.ANYSEARCH_API_KEY, undefined);
});

test("test runtime 对未知或空白 AnySearch phase fail closed", () => {
  for (const phase of ["", " ", "fake-anysearch-public-job-v2"]) {
    assert.throws(() => createRuntimeConfig({ test: true, anysearchPublicJobPhase: phase }), /JOB_DISCOVERY_RUNTIME_CONFIG_INVALID/);
  }
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

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeAnysearchPublicJobMissingKeyPhase, fakeAnysearchPublicJobPhase, startFakeAnysearchFixtureServer } from "./fake-anysearch-fixture-server.mjs";

export const testRuntime = Object.freeze({
  composeProject: "job-copilot-issue-2-e2e",
  devAuthSharedSecret: "issue-2-e2e-dev-auth-shared-secret",
  webPort: "3120",
  apiPort: "3121",
  postgresPort: "55420",
  redisPort: "64790",
  minioApiPort: "59100",
  minioConsolePort: "59101",
  mailpitHttpPort: "58126",
  mailpitSmtpPort: "51125",
});

export function createRuntimeConfig({ test = false, env = process.env, anysearchPublicJobPhase = test ? env.E2E_ANYSEARCH_PUBLIC_JOB_PHASE : undefined } = {}) {
  const supportedAnysearchPhase = anysearchPublicJobPhase === fakeAnysearchPublicJobPhase || anysearchPublicJobPhase === fakeAnysearchPublicJobMissingKeyPhase;
  if (test && anysearchPublicJobPhase !== undefined && !supportedAnysearchPhase) throw new Error("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
  if (test) {
    return {
      ...testRuntime,
      anysearchFixturePort: supportedAnysearchPhase ? "39334" : undefined,
      anysearchPublicJobPhase: supportedAnysearchPhase ? anysearchPublicJobPhase : undefined,
      appEnv: "test",
      test: true,
    };
  }

  return {
    appEnv: "local",
    apiPort: env.API_PORT ?? "3021",
    composeProject: undefined,
    devAuthSharedSecret: env.DEV_AUTH_SHARED_SECRET ?? randomBytes(32).toString("hex"),
    mailpitHttpPort: env.MAILPIT_HTTP_PORT ?? "58025",
    mailpitSmtpPort: env.MAILPIT_SMTP_PORT ?? "51025",
    minioApiPort: env.MINIO_API_PORT ?? "59000",
    minioConsolePort: env.MINIO_CONSOLE_PORT ?? "59001",
    postgresPort: env.POSTGRES_PORT ?? "54320",
    redisPort: env.REDIS_PORT ?? "63790",
    test: false,
    webPort: env.WEB_PORT ?? "3020",
  };
}

function composeArgs(config, args) {
  return config.composeProject
    ? ["compose", "--project-name", config.composeProject, ...args]
    : ["compose", ...args];
}

function infrastructureEnv(config) {
  return {
    ...process.env,
    POSTGRES_PORT: config.postgresPort,
    REDIS_PORT: config.redisPort,
    MINIO_API_PORT: config.minioApiPort,
    MINIO_CONSOLE_PORT: config.minioConsolePort,
    MAILPIT_HTTP_PORT: config.mailpitHttpPort,
    MAILPIT_SMTP_PORT: config.mailpitSmtpPort,
  };
}

export async function cleanupInfrastructure({ config, run }) {
  if (!config.test) {
    return;
  }
  await run("docker", composeArgs(config, ["down", "-v", "--remove-orphans"]), {
    env: infrastructureEnv(config),
  });
}

export async function prepareInfrastructure({ run, config = createRuntimeConfig() }) {
  try {
    await run("docker", ["compose", "version"], { env: infrastructureEnv(config) });
  } catch {
    throw new Error("Docker Compose 不可用，无法启动本地生产形态依赖");
  }

  await cleanupInfrastructure({ config, run });
  await run("docker", composeArgs(config, ["up", "-d", "--wait", "postgres", "redis", "minio", "mailpit"]), {
    env: infrastructureEnv(config),
  });
  await run("docker", composeArgs(config, ["up", "-d", "minio-init"]), {
    env: infrastructureEnv(config),
  });
  await run("docker", composeArgs(config, ["wait", "minio-init"]), {
    env: infrastructureEnv(config),
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

export function runDatabaseMigrations({ runProcess = run, config }) {
  return runProcess(
    "pnpm",
    ["--filter", "@job-copilot/database", "exec", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://job_copilot:local_only_job_copilot@127.0.0.1:${config.postgresPort}/job_copilot`,
      },
    },
  );
}

function applicationEnv(config, env) {
  const inheritedEnvironment = { ...env };
  if (config.anysearchPublicJobPhase) {
    for (const key of ["ANYSEARCH_API_KEY", "ANYSEARCH_BASE_URL", "ANYSEARCH_PROVIDER_BASE_URL", "E2E_AGENT_RUN_SCENARIOS", "E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS", "E2E_SOURCE_HEALTH_ONLY", "JOB_PAGE_FETCHER_TEST_ORIGIN"]) delete inheritedEnvironment[key];
  }
  return {
    ...inheritedEnvironment,
    APP_ENV: config.appEnv,
    AUTH_MODE: "dev",
    DEV_AUTH_SHARED_SECRET: config.devAuthSharedSecret,
    PORT: config.webPort,
    API_PORT: config.apiPort,
    API_INTERNAL_URL: `http://127.0.0.1:${config.apiPort}`,
    DATABASE_URL: `postgresql://job_copilot:local_only_job_copilot@127.0.0.1:${config.postgresPort}/job_copilot`,
    REDIS_PORT: config.redisPort,
    REDIS_URL: `redis://127.0.0.1:${config.redisPort}`,
    MINIO_API_PORT: config.minioApiPort,
    MINIO_CONSOLE_PORT: config.minioConsolePort,
    MINIO_ENDPOINT: `http://127.0.0.1:${config.minioApiPort}`,
    MINIO_ACCESS_KEY: "job_copilot",
    MINIO_SECRET_KEY: "local_only_job_copilot_secret",
    MINIO_BUCKET: "career-documents",
    MAILPIT_HTTP_PORT: config.mailpitHttpPort,
    MAILPIT_SMTP_PORT: config.mailpitSmtpPort,
    MAILPIT_ENDPOINT: `http://127.0.0.1:${config.mailpitHttpPort}`,
    NEXT_PUBLIC_AUTH_MODE: "dev",
    PUBLIC_SOURCE_NETWORK_MODE: config.test ? "disabled" : env.PUBLIC_SOURCE_NETWORK_MODE,
    ...(config.anysearchPublicJobPhase ? {
      ...(config.anysearchPublicJobPhase === fakeAnysearchPublicJobPhase ? { ANYSEARCH_API_KEY: "fake-anysearch-public-job-test-key" } : {}),
      ANYSEARCH_BASE_URL: "http://127.0.0.1:" + config.anysearchFixturePort,
      ANYSEARCH_PROVIDER_BASE_URL: "http://127.0.0.1:" + config.anysearchFixturePort,
      E2E_ANYSEARCH_PUBLIC_JOB_PHASE: config.anysearchPublicJobPhase,
      JOB_PAGE_FETCHER_TEST_ORIGIN: "http://127.0.0.1:" + config.anysearchFixturePort,
    } : {}),
  };
}

export function startApplications({ spawnProcess = spawn, env = process.env, config } = {}) {
  const runtime = config ?? createRuntimeConfig({ env });
  return spawnProcess(
    "pnpm",
    ["--parallel", "--stream", "--filter", "web", "--filter", "api", "--filter", "worker", "dev"],
    {
      detached: false,
      stdio: "inherit",
      env: applicationEnv(runtime, env),
    },
  );
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("本地测试运行时启动已取消");
}

function sleep(milliseconds, { signal } = {}) {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForSuccessfulResponse(url, { fetchImpl = fetch, timeoutMs = 90_000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    try {
      const response = await fetchImpl(url, { signal });
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      lastError = error;
    }
    await sleep(500, { signal });
  }
  throw new Error(`Timed out waiting for ${url}`, { cause: lastError });
}

export async function waitForRuntime({ config, fetchImpl = fetch, signal } = {}) {
  await waitForSuccessfulResponse(`http://127.0.0.1:${config.apiPort}/health/ready`, { fetchImpl, signal });
  await waitForSuccessfulResponse(`http://127.0.0.1:${config.webPort}/login`, { fetchImpl, signal });
}

function stopApplications(child, signal = "SIGTERM") {
  if (!child?.pid || child.killed || typeof child.exitCode === "number" || child.signalCode) {
    return;
  }
  child.kill(signal);
}

function waitForApplicationExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function applicationExitError({ code, signal }) {
  const error = new Error(signal
    ? `应用进程被 ${signal} 终止`
    : `应用进程以退出码 ${code} 结束`);
  error.exitCode = signal ? signalExitCode(signal) : (code || 1);
  return error;
}

export async function runRuntime({
  config,
  signalSource = process,
  fetchImpl = fetch,
  prepare = ({ config: runtimeConfig }) => prepareInfrastructure({ config: runtimeConfig, run }),
  migrate = ({ config: runtimeConfig }) => runDatabaseMigrations({ config: runtimeConfig }),
  start = ({ config: runtimeConfig }) => startApplications({ config: runtimeConfig }),
  waitForReady = ({ config: runtimeConfig, signal }) => waitForRuntime({ config: runtimeConfig, fetchImpl, signal }),
  startFixtureServer = ({ config: runtimeConfig, signal }) => runtimeConfig.anysearchPublicJobPhase
    ? startFakeAnysearchFixtureServer({ port: Number(runtimeConfig.anysearchFixturePort), signal })
    : undefined,
  cleanup = ({ config: runtimeConfig }) => cleanupInfrastructure({ config: runtimeConfig, run }),
} = {}) {
  let child;
  let childExit;
  let childExited = false;
  let requestedSignal;
  let fixtureServer;
  let readiness;
  const readinessController = new AbortController();
  const fixtureController = new AbortController();
  let resolveSignal;
  const signalReceived = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const requestShutdown = (signal) => {
    if (!requestedSignal) {
      requestedSignal = signal;
      resolveSignal(signal);
    }
  };
  const handleSigint = () => requestShutdown("SIGINT");
  const handleSigterm = () => requestShutdown("SIGTERM");
  signalSource.once("SIGINT", handleSigint);
  signalSource.once("SIGTERM", handleSigterm);

  const awaitChildExit = async () => {
    const result = await childExit;
    childExited = true;
    return result;
  };
  const cancelReadiness = (message) => {
    if (!readinessController.signal.aborted) {
      readinessController.abort(new Error(message));
    }
  };

  try {
    await prepare({ config });
    await migrate({ config });
    fixtureServer = await startFixtureServer({ config, signal: fixtureController.signal });
    child = start({ config });
    childExit = waitForApplicationExit(child);
    readiness = waitForReady({ config, signal: readinessController.signal }).then(
      () => ({ type: "ready" }),
      (error) => ({ type: "readiness-error", error }),
    );

    const readyOrShutdown = await Promise.race([
      readiness,
      signalReceived.then((signal) => ({ type: "signal", signal })),
      awaitChildExit().then((result) => ({ type: "exit", result })),
    ]);

    if (readyOrShutdown.type === "exit") {
      cancelReadiness("应用进程在就绪前退出");
      await readiness;
      throw applicationExitError(readyOrShutdown.result);
    }

    if (readyOrShutdown.type === "signal") {
      fixtureController.abort(new Error("应用启动期间收到退出信号"));
      cancelReadiness(`收到 ${readyOrShutdown.signal}`);
      await readiness;
      stopApplications(child, readyOrShutdown.signal);
      await awaitChildExit();
      return { exitCode: signalExitCode(readyOrShutdown.signal) };
    }

    if (readyOrShutdown.type === "readiness-error") {
      throw readyOrShutdown.error;
    }

    console.log("本地测试运行时已就绪");
    const exitOrShutdown = await Promise.race([
      signalReceived.then((signal) => ({ type: "signal", signal })),
      awaitChildExit().then((result) => ({ type: "exit", result })),
    ]);

    if (exitOrShutdown.type === "signal") {
      fixtureController.abort(new Error("应用就绪后收到退出信号"));
      stopApplications(child, exitOrShutdown.signal);
      await awaitChildExit();
      return { exitCode: signalExitCode(exitOrShutdown.signal) };
    }

    if (exitOrShutdown.result.code !== 0 || exitOrShutdown.result.signal) {
      throw applicationExitError(exitOrShutdown.result);
    }
    return { exitCode: 0 };
  } finally {
    fixtureController.abort(new Error("本地测试运行时正在退出"));
    cancelReadiness("本地测试运行时正在退出");
    signalSource.removeListener("SIGINT", handleSigint);
    signalSource.removeListener("SIGTERM", handleSigterm);
    if (child && !childExited) {
      stopApplications(child, requestedSignal ?? "SIGTERM");
      await awaitChildExit();
    }
    await fixtureServer?.close();
    await cleanup({ config });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = createRuntimeConfig({ test: process.argv.includes("--test") });
  runRuntime({ config }).then(
    ({ exitCode }) => { process.exitCode = exitCode; },
    (error) => {
      console.error(error);
      process.exitCode = error.exitCode ?? 1;
    },
  );
}

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

export function createRuntimeConfig({ test = false, env = process.env } = {}) {
  if (test) {
    return { ...testRuntime, appEnv: "test", test: true };
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
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, "--import=tsx"].filter(Boolean).join(" "),
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
    MAILPIT_HTTP_PORT: config.mailpitHttpPort,
    MAILPIT_SMTP_PORT: config.mailpitSmtpPort,
    MAILPIT_ENDPOINT: `http://127.0.0.1:${config.mailpitHttpPort}`,
    NEXT_PUBLIC_AUTH_MODE: "dev",
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSuccessfulResponse(url, { fetchImpl = fetch, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`, { cause: lastError });
}

export async function waitForRuntime({ config, fetchImpl = fetch }) {
  await waitForSuccessfulResponse(`http://127.0.0.1:${config.apiPort}/health/ready`, { fetchImpl });
  await waitForSuccessfulResponse(`http://127.0.0.1:${config.webPort}/login`, { fetchImpl });
}

function stopApplications(child, signal = "SIGTERM") {
  if (!child?.pid || child.killed || typeof child.exitCode === "number" || child.signalCode) {
    return;
  }
  child.kill(signal);
}

function waitForApplicationExit(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

async function main() {
  const config = createRuntimeConfig({ test: process.argv.includes("--test") });
  let child;
  let cleanedUp = false;
  const cleanup = async () => {
    if (!cleanedUp) {
      cleanedUp = true;
      await cleanupInfrastructure({ config, run });
    }
  };
  const shutdown = async (signal) => {
    stopApplications(child, signal);
    await cleanup();
  };

  const handleSignal = (signal, exitCode) => {
    void shutdown(signal).finally(() => {
      process.exit(exitCode);
    });
  };
  process.once("SIGINT", () => handleSignal("SIGINT", 130));
  process.once("SIGTERM", () => handleSignal("SIGTERM", 143));

  try {
    await prepareInfrastructure({ config, run });
    if (config.test) {
      await runDatabaseMigrations({ config });
    }
    child = startApplications({ config });
    await waitForRuntime({ config });
    console.log("本地测试运行时已就绪");
    await waitForApplicationExit(child);
  } finally {
    stopApplications(child);
    await cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

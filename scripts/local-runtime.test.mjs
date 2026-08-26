import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeConfig, prepareInfrastructure, startApplications } from "./local-runtime.mjs";

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

  const [, , options] = spawnCall;
  assert.equal(options.env.APP_ENV, "test");
  assert.equal(options.env.PORT, "3120");
  assert.equal(options.env.API_PORT, "3121");
  assert.equal(options.env.API_INTERNAL_URL, "http://127.0.0.1:3121");
  assert.equal(options.env.DATABASE_URL, "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot");
  assert.equal(options.env.REDIS_URL, "redis://127.0.0.1:64790");
  assert.equal(options.env.MINIO_ENDPOINT, "http://127.0.0.1:59100");
  assert.equal(options.env.MAILPIT_ENDPOINT, "http://127.0.0.1:58126");
  assert.equal(options.env.DEV_AUTH_SHARED_SECRET, "issue-2-e2e-dev-auth-shared-secret");
  assert.match(options.env.NODE_OPTIONS, /--import=tsx/);
  assert.equal(options.env.UNRELATED_VALUE, "preserved");
});

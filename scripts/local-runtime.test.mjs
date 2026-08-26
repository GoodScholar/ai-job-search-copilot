import assert from "node:assert/strict";
import test from "node:test";
import { prepareInfrastructure, startApplications } from "./local-runtime.mjs";

test("starts compose and waits for healthy dependencies before applications", async () => {
  const calls = [];
  await prepareInfrastructure({
    run: async (command, args) => calls.push([command, ...args]),
  });

  assert.deepEqual(calls, [
    ["docker", "compose", "version"],
    ["docker", "compose", "up", "-d", "--wait"],
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
  assert.equal(options.env.UNRELATED_VALUE, "preserved");
});

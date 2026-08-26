import assert from "node:assert/strict";
import test from "node:test";
import { prepareInfrastructure } from "./local-runtime.mjs";

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

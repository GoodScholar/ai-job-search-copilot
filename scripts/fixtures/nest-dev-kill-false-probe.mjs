import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runNestDev } from "../nest-dev.mjs";

const controlledChildPath = fileURLToPath(new URL("./nest-dev-controlled-child.mjs", import.meta.url));
const child = spawn(process.execPath, [controlledChildPath], {
  env: process.env,
  stdio: "ignore",
});

child.kill = () => false;

process.exit(await runNestDev({
  command: {},
  spawnProcess: () => child,
  shutdownTimeoutMs: Number(process.env.NEST_DEV_TEST_SHUTDOWN_TIMEOUT_MS),
  shutdownCloseTimeoutMs: Number(process.env.NEST_DEV_TEST_SHUTDOWN_CLOSE_TIMEOUT_MS),
}));

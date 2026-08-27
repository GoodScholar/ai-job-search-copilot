import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const tsxLoader = "--import=tsx";

export function createNestDevCommand({
  cwd = process.cwd(),
  nodeExecutable = process.execPath,
  env = process.env,
} = {}) {
  const nodeOptions = env.NODE_OPTIONS?.includes(tsxLoader)
    ? env.NODE_OPTIONS
    : [env.NODE_OPTIONS, tsxLoader].filter(Boolean).join(" ");

  return {
    args: [
      tsxLoader,
      resolve(cwd, "node_modules/@nestjs/cli/bin/nest.js"),
      "start",
      "--watch",
    ],
    env: { ...env, NODE_OPTIONS: nodeOptions },
    nodeExecutable,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = createNestDevCommand();
  const child = spawn(command.nodeExecutable, command.args, {
    cwd: process.cwd(),
    env: command.env,
    stdio: "inherit",
  });

  child.once("error", (error) => {
    throw error;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

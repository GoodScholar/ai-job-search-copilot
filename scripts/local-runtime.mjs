import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function prepareInfrastructure({ run }) {
  try {
    await run("docker", ["compose", "version"]);
  } catch {
    throw new Error("Docker Compose 不可用，无法启动本地生产形态依赖");
  }

  await run("docker", ["compose", "up", "-d", "--wait"]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
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

async function main() {
  await prepareInfrastructure({ run });

  const child = spawn(
    "pnpm",
    ["--parallel", "--stream", "--filter", "web", "--filter", "api", "--filter", "worker", "dev"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DEV_AUTH_SHARED_SECRET: process.env.DEV_AUTH_SHARED_SECRET ?? randomBytes(32).toString("hex"),
        PORT: process.env.WEB_PORT ?? "3020",
        API_PORT: process.env.API_PORT ?? "3021",
      },
    },
  );

  const forwardSignal = (signal) => child.kill(signal);
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  child.once("error", (error) => {
    throw error;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

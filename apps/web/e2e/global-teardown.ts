import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

export default function globalTeardown(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["compose", "--project-name", "job-copilot-issue-2-e2e", "down", "-v", "--remove-orphans"],
      { cwd: repositoryRoot, stdio: "inherit" },
    );

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`测试 Compose 清理失败，退出码 ${code}`));
      }
    });
  });
}

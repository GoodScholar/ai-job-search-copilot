import { appendFile, writeFile } from "node:fs/promises";

const pidPath = process.env.NEST_DEV_TEST_PID_FILE;
const readyPath = process.env.NEST_DEV_TEST_READY_FILE;
const signalPath = process.env.NEST_DEV_TEST_SIGNAL_FILE;
const mode = process.env.NEST_DEV_TEST_MODE;

await writeFile(pidPath, String(process.pid));

if (mode === "exit") {
  process.exit(Number(process.env.NEST_DEV_TEST_EXIT_CODE));
}

if (mode === "self-signal") {
  process.kill(process.pid, "SIGTERM");
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void appendFile(signalPath, `${signal}\n`).then(() => setTimeout(() => process.exit(0), 50));
  });
}

await writeFile(readyPath, "ready");
setInterval(() => {}, 1_000);

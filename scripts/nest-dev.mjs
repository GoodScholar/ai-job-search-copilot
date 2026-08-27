import { spawn } from "node:child_process";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tsxLoader = "--import=tsx";

function nodeOptionTokens(nodeOptions = "") {
  const tokens = [];
  let quote;
  let token = "";

  for (const character of nodeOptions) {
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "\"") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
    } else {
      token += character;
    }
  }
  if (quote) return [];
  if (token) tokens.push(token);
  return tokens;
}

function hasTsxLoader(nodeOptions) {
  const tokens = nodeOptionTokens(nodeOptions);
  return tokens.some((token, index) => token === tsxLoader || (token === "--import" && tokens[index + 1] === "tsx"));
}

function signalExitCode(signal) {
  const signalNumber = constants.signals[signal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

export function createNestDevCommand({
  cwd = process.cwd(),
  nodeExecutable = process.execPath,
  env = process.env,
} = {}) {
  const nodeOptions = hasTsxLoader(env.NODE_OPTIONS)
    ? env.NODE_OPTIONS
    : [env.NODE_OPTIONS, tsxLoader].filter(Boolean).join(" ");

  return {
    args: [tsxLoader, resolve(cwd, "node_modules/@nestjs/cli/bin/nest.js"), "start", "--watch"],
    env: { ...env, NODE_OPTIONS: nodeOptions },
    nodeExecutable,
  };
}

export function runNestDev({
  command = createNestDevCommand(),
  signalSource = process,
  spawnProcess = spawn,
  shutdownTimeoutMs = 10_000,
  shutdownCloseTimeoutMs = 250,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let forwardedSignal;
    let runtimeFailure = false;
    let shutdownTimer;
    let handleChildExit;
    let terminationRequested = false;
    let settled = false;

    const removeHandlers = () => {
      signalSource.removeListener("SIGINT", forwardSignal);
      signalSource.removeListener("SIGTERM", forwardSignal);
    };
    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(shutdownTimer);
      removeHandlers();
      child?.removeListener("error", handleChildError);
      if (handleChildExit) child?.removeListener("exit", handleChildExit);
      child?.unref?.();
      resolve(exitCode);
    };
    const tryKill = (signal) => {
      try {
        return child?.kill(signal) === true;
      } catch {
        return false;
      }
    };
    const stopChild = (signal) => {
      if (terminationRequested || !child) return false;
      terminationRequested = true;
      return tryKill(signal);
    };
    const boundTermination = () => {
      if (shutdownTimer || settled) return;
      shutdownTimer = setTimeout(() => {
        if (settled) return;
        if (!tryKill("SIGKILL")) {
          settle(1);
          return;
        }
        shutdownTimer = setTimeout(() => settle(1), shutdownCloseTimeoutMs);
      }, shutdownTimeoutMs);
    };
    const forwardSignal = (signal) => {
      if (terminationRequested || !child) return;
      if (stopChild(signal)) forwardedSignal = signal;
      boundTermination();
    };
    const handleChildError = () => {
      if (!child?.pid) {
        settle(1);
        return;
      }
      runtimeFailure = true;
      stopChild("SIGTERM");
      boundTermination();
    };

    signalSource.on("SIGINT", forwardSignal);
    signalSource.on("SIGTERM", forwardSignal);

    try {
      child = spawnProcess(command.nodeExecutable, command.args, {
        cwd: process.cwd(),
        env: command.env,
        stdio: "inherit",
      });
    } catch {
      settle(1);
      return;
    }

    handleChildExit = (code, signal) => {
      settle(
        forwardedSignal
          ? signalExitCode(forwardedSignal)
          : runtimeFailure
            ? 1
            : signal
              ? signalExitCode(signal)
              : code ?? 1,
      );
    };
    child.once("error", handleChildError);
    child.once("exit", handleChildExit);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await runNestDev());
}

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const sourceHealthSpec = "source-health.spec.ts";
const anysearchSpec = "anysearch-public-job-discovery.spec.ts";
const fakeAnysearchPublicJobPhase = "fake-anysearch-public-job-v1";
const phases = ["ordinary", "source-health"];
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");

/** @typedef {string[] | { error: { code: number | null, signal?: string }, signal?: never } | { signal: string, error?: never }} E2EPhaseSelection */

export function normalizeE2EArguments(arguments_) {
  return arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
}

function phaseEnvironment(phase, environment) {
  const baseEnvironment = { ...environment };
  delete baseEnvironment.E2E_ANYSEARCH_PUBLIC_JOB_PHASE;
  delete baseEnvironment.ANYSEARCH_BASE_URL;
  delete baseEnvironment.ANYSEARCH_PROVIDER_BASE_URL;
  if (phase === "anysearch") {
    for (const key of ["E2E_AGENT_RUN_SCENARIOS", "E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS", "E2E_SOURCE_HEALTH_ONLY", "JOB_PAGE_FETCHER_TEST_ORIGIN"]) delete baseEnvironment[key];
    return { ...baseEnvironment, E2E_ANYSEARCH_PUBLIC_JOB_PHASE: fakeAnysearchPublicJobPhase };
  }
  delete baseEnvironment.E2E_SOURCE_HEALTH_ONLY;
  return phase === "source-health" ? { ...baseEnvironment, E2E_SOURCE_HEALTH_ONLY: "1" } : baseEnvironment;
}

function explicitSpecPhase(arguments_) {
  const specs = arguments_.filter((argument) => argument.includes(".spec.ts"));
  if (!specs.length) return null;
  const anysearch = specs.some((spec) => spec.includes(anysearchSpec));
  const sourceHealth = specs.some((spec) => spec.includes(sourceHealthSpec));
  const ordinary = specs.some((spec) => !spec.includes(sourceHealthSpec) && !spec.includes(anysearchSpec));
  if (anysearch && !sourceHealth && !ordinary) return ["anysearch"];
  if (sourceHealth && !ordinary && !anysearch) return ["source-health"];
  if (ordinary && !sourceHealth && !anysearch) return ["ordinary"];
  return null;
}

function listedTestCount(stdout) {
  const match = /Total:\s*(\d+)\s+tests?/u.exec(stdout);
  return match ? Number(match[1]) : 0;
}

/** @returns {Promise<E2EPhaseSelection>} */
export async function selectE2EPhases(arguments_, run) {
  if (!arguments_.length) return phases;
  const explicit = explicitSpecPhase(arguments_);
  if (explicit) return explicit;
  if (!run) return phases;

  const selected = [];
  for (const phase of phases) {
    const result = await run({ phase, args: ["--list", ...arguments_], environment: phaseEnvironment(phase, {}) });
    if (result.signal) return { signal: result.signal };
    if (listedTestCount(result.stdout) > 0) selected.push(phase);
    else if (result.code && !/No tests found/u.test(result.stdout)) return { error: result };
  }
  return selected;
}

export async function executeE2E(arguments_, { environment = process.env, run }) {
  const phaseRun = (call) => run({ ...call, environment: phaseEnvironment(call.phase, environment) });
  const selected = await selectE2EPhases(arguments_, phaseRun);
  if ("signal" in selected) return { signal: selected.signal };
  if ("error" in selected) return { code: selected.error.code ?? 1, signal: selected.error.signal };
  if (!selected.length) return { code: 1 };
  for (const phase of selected) {
    const result = await phaseRun({ phase, args: arguments_ });
    if (result.signal) return { signal: result.signal };
    if (result.code) return { code: result.code };
  }
  return { code: 0 };
}

export function createProcessRunner({
  processRef = process,
  spawnProcess = spawn,
  playwrightCliPath = playwrightCli,
} = {}) {
  let activeChild;
  let interruption;
  const forward = (signal) => {
    interruption ??= signal;
    activeChild?.kill(signal);
  };
  processRef.on("SIGINT", forward);
  processRef.on("SIGTERM", forward);

  return {
    run: ({ args, environment }) => new Promise((resolve) => {
      if (interruption) {
        resolve({ code: null, signal: interruption, stdout: "" });
        return;
      }
      const child = spawnProcess(processRef.execPath, [playwrightCliPath, "test", ...args], { cwd: processRef.cwd(), env: environment, stdio: ["inherit", "pipe", "pipe"] });
      activeChild = child;
      let stdout = "";
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (activeChild === child) activeChild = undefined;
        resolve(result);
      };
      child.stdout.on("data", (chunk) => { stdout += chunk; processRef.stdout.write(chunk); });
      child.stderr.on("data", (chunk) => { stdout += chunk; processRef.stderr.write(chunk); });
      child.on("close", (code, signal) => {
        finish({ code, signal: interruption ?? signal, stdout });
      });
      child.on("error", () => finish({ code: 1, signal: interruption, stdout }));
    }),
    dispose: () => {
      processRef.off("SIGINT", forward);
      processRef.off("SIGTERM", forward);
    },
  };
}

async function main() {
  const processRunner = createProcessRunner();
  const result = await executeE2E(normalizeE2EArguments(process.argv.slice(2)), { run: processRunner.run });
  processRunner.dispose();
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.code ?? 1;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) void main();

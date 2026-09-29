import { createDatabase } from "@job-copilot/database";
import { createJourneyMetrics } from "@job-copilot/domain/journey-metrics";
import { resolveJobDiscoveryExecutionMode } from "@job-copilot/domain/job-discovery-execution-mode";
import { z } from "zod";
import { createWorkerRunPreflight } from "../agent-runs/run-preflight.js";

async function main() {
  const [command, userId, configuration] = process.argv.slice(2);
  if (!["enroll", "report", "events"].includes(command ?? "") || !process.env.DATABASE_URL) throw new Error("JOURNEY_METRIC_COMMAND_INVALID");
  const enrollment = command === "enroll" ? z.object({ userId: z.uuid(), configuration: z.enum(["valid", "invalid"]) }).parse({ userId, configuration }) : null;
  const db = createDatabase(process.env.DATABASE_URL);
  try {
    const metrics = createJourneyMetrics({ db, clock: () => new Date(), runPreflight: createWorkerRunPreflight({ executionMode: resolveJobDiscoveryExecutionMode(process.env) }) });
    if (enrollment) console.log(JSON.stringify({ journeyId: await metrics.enroll(enrollment) }));
    else {
      await metrics.collect();
      console.log(JSON.stringify(command === "events" ? await metrics.events() : await metrics.summary(), null, 2));
    }
  } finally { await db.$client.end(); }
}
void main().catch(() => { console.error("JOURNEY_METRIC_COMMAND_FAILED"); process.exitCode = 1; });

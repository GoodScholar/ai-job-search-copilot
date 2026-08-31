import { createVerifiedJobSourceGate as createInternalGate } from "./verified-job-source-gate";

export {
  VerifiedJobEvidenceStoreUnavailableError,
  VerifiedJobSourceGateError,
} from "./verified-job-source-gate";
export type { VerifiedJobEvidenceStore } from "./verified-job-source-gate";

/** Package consumers retain ordinary verification; claim authority stays on the v4 internal seam. */
export function createVerifiedJobSourceGate(input: Parameters<typeof createInternalGate>[0]) {
  const gate = createInternalGate(input);
  return {
    verify: gate.verify,
    reject: gate.reject,
  };
}

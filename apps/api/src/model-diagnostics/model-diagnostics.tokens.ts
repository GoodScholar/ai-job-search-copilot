import type { createModelDiagnostics } from "@job-copilot/domain/model-diagnostics";
export const MODEL_DIAGNOSTICS = Symbol("MODEL_DIAGNOSTICS");
export type ModelDiagnostics = ReturnType<typeof createModelDiagnostics>;

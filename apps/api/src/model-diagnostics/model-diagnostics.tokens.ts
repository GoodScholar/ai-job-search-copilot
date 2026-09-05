import type { createModelDiagnostics } from "@job-copilot/domain/model-diagnostics";
import type { ModelDiagnosticAdapter } from "@job-copilot/contracts/model-diagnostics";
import type { ModelDiagnosticProjectionReader } from "@job-copilot/domain/model-diagnostics";
export const MODEL_DIAGNOSTICS = Symbol("MODEL_DIAGNOSTICS");
export type ModelDiagnostics = ReturnType<typeof createModelDiagnostics>;
export const MODEL_DIAGNOSTIC_ADAPTER = Symbol("MODEL_DIAGNOSTIC_ADAPTER");
export const MODEL_DIAGNOSTIC_PROJECTION_READER = Symbol("MODEL_DIAGNOSTIC_PROJECTION_READER");
export type ModelDiagnosticProjection = ModelDiagnosticProjectionReader;
export type ModelDiagnosticsAdapter = ModelDiagnosticAdapter;

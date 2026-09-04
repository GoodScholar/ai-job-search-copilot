import {
  SourceCapabilityDeclarationSchema,
  SourceCapabilityRejectionSchema,
  SourceCapabilitySchema,
  declareFormalBetaSourceCapabilities,
  mismatchedSourceCapabilityDeclaration,
  unsupportedSourceCapability,
  type SourceCapabilityDeclaration,
  type SourceCapabilityRejection,
  type SourceCapability,
} from "@job-copilot/contracts/source-capabilities";
import { GREENHOUSE_JOB_DISCOVERY_ADAPTER, GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION } from "@job-copilot/contracts/agent-runs";
import { z } from "zod";

/** 当前已执行的来源动作；safe-open 仅声明/展示，尚未进入执行面。 */
export const SourceExecutionActionSchema = SourceCapabilitySchema.exclude(["safe_open_original_page"]);
export type SourceExecutionAction = z.infer<typeof SourceExecutionActionSchema>;

export interface SourceCapabilityAdapter {
  readonly adapter: string;
  readonly adapterVersion: string;
  declareCapabilities(input: { sourceId: string }): SourceCapabilityDeclaration;
}

/** 服务端 Greenhouse v2 声明端口；Worker 与 API 均复用同一 contracts 构造器。 */
export class GreenhouseSourceCapabilityAdapter implements SourceCapabilityAdapter {
  readonly adapter = GREENHOUSE_JOB_DISCOVERY_ADAPTER;
  readonly adapterVersion = GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION;
  declareCapabilities(input: { sourceId: string }): SourceCapabilityDeclaration {
    return declareFormalBetaSourceCapabilities({ sourceId: input.sourceId, adapter: this.adapter, adapterVersion: this.adapterVersion });
  }
}

export type SourceActionAuthorization = { allowed: true } | { allowed: false; failure: SourceCapabilityRejection };

/** 只以版本化声明授权来源动作；来源健康由受控检查独立解释。 */
export function authorizeSourceAction(input: {
  declaration: SourceCapabilityDeclaration;
  action: SourceCapability;
  expected: { sourceId: string; adapter: string; adapterVersion: string };
}): SourceActionAuthorization {
  const declaration = SourceCapabilityDeclarationSchema.parse(input.declaration);
  const action = SourceCapabilitySchema.parse(input.action);
  if (declaration.sourceId !== input.expected.sourceId
    || declaration.adapter !== input.expected.adapter
    || declaration.adapterVersion !== input.expected.adapterVersion) {
    return { allowed: false, failure: SourceCapabilityRejectionSchema.parse(mismatchedSourceCapabilityDeclaration()) };
  }
  if (declaration.capabilities.includes(action)) return { allowed: true };
  return { allowed: false, failure: SourceCapabilityRejectionSchema.parse(unsupportedSourceCapability()) };
}

import {
  SourceCapabilityDeclarationSchema,
  SourceCapabilityRejectionSchema,
  SourceCapabilitySchema,
  unsupportedSourceCapability,
  type SourceCapabilityDeclaration,
  type SourceCapabilityRejection,
  type SourceCapability,
} from "@job-copilot/contracts/source-capabilities";

export interface SourceCapabilityAdapter {
  declareCapabilities(input: { sourceId: string }): SourceCapabilityDeclaration;
}

export type SourceActionAuthorization = { allowed: true } | { allowed: false; failure: SourceCapabilityRejection };

/** 只以版本化声明授权来源动作；来源健康由受控检查独立解释。 */
export function authorizeSourceAction(input: {
  declaration: SourceCapabilityDeclaration;
  action: SourceCapability;
}): SourceActionAuthorization {
  const declaration = SourceCapabilityDeclarationSchema.parse(input.declaration);
  const action = SourceCapabilitySchema.parse(input.action);
  if (declaration.capabilities.includes(action)) return { allowed: true };
  return { allowed: false, failure: SourceCapabilityRejectionSchema.parse(unsupportedSourceCapability()) };
}

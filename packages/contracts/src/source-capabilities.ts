import { z } from "zod";

export const SOURCE_CAPABILITY_CONTRACT_VERSION = "source-capabilities-v1";

export const SourceCapabilitySchema = z.enum([
  "active_discovery",
  "read_details",
  "continuous_monitoring",
  "safe_open_original_page",
]);

export const SourceCapabilityImpactSchema = z.object({
  scope: z.literal("entire_source"),
  affectedCount: z.null(),
}).strict();

export const SourceCapabilitySuggestedActionSchema = z.enum(["review_source_capabilities"]);

export const SourceCapabilityRejectionSchema = z.object({
  reasonCode: z.literal("SOURCE_CAPABILITY_UNSUPPORTED"),
  impact: SourceCapabilityImpactSchema,
  retryable: z.literal(false),
  suggestedActions: z.tuple([SourceCapabilitySuggestedActionSchema]),
}).strict();

export const SourceCapabilityDeclarationSchema = z.object({
  sourceId: z.string().trim().min(1).max(256),
  adapter: z.string().trim().min(1).max(128),
  adapterVersion: z.string().trim().min(1).max(128),
  contractVersion: z.literal(SOURCE_CAPABILITY_CONTRACT_VERSION),
  capabilities: z.array(SourceCapabilitySchema).max(4).refine(
    (capabilities) => new Set(capabilities).size === capabilities.length,
    { message: "source capabilities must be unique" },
  ),
}).strict();

export type SourceCapability = z.infer<typeof SourceCapabilitySchema>;
export type SourceCapabilityDeclaration = z.infer<typeof SourceCapabilityDeclarationSchema>;
export type SourceCapabilityRejection = z.infer<typeof SourceCapabilityRejectionSchema>;

export function declareFormalBetaSourceCapabilities(input: {
  sourceId: string;
  adapter: string;
  adapterVersion: string;
}): SourceCapabilityDeclaration {
  return SourceCapabilityDeclarationSchema.parse({
    ...input,
    contractVersion: SOURCE_CAPABILITY_CONTRACT_VERSION,
    capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"],
  });
}

export function unsupportedSourceCapability(): SourceCapabilityRejection {
  return SourceCapabilityRejectionSchema.parse({
    reasonCode: "SOURCE_CAPABILITY_UNSUPPORTED",
    impact: { scope: "entire_source", affectedCount: null },
    retryable: false,
    suggestedActions: ["review_source_capabilities"],
  });
}

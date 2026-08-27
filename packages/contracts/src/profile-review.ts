import { z } from "zod";

const version = z.int().min(0);
const reason = z.string().trim().min(1).max(500);
const namedValue = z.object({ name: z.string().trim().min(1).max(500) }).strict();
const summaryValue = z.object({ summary: z.string().trim().min(1).max(2_000) }).strict();
const languageValue = z.object({
  name: z.string().trim().min(1).max(200),
  level: z.string().trim().min(1).max(200).optional(),
}).strict();

export const ProfileFactTypeSchema = z.enum([
  "experience", "education", "skill", "project", "language", "achievement", "certification", "work_eligibility",
]);
export const ImportedCandidateFactTypeSchema = ProfileFactTypeSchema.exclude(["work_eligibility"]);
export const ProfileFactValueSchema = z.union([namedValue, summaryValue, languageValue]);

const factValueFor = <T extends z.ZodType>(factType: z.infer<typeof ProfileFactTypeSchema>, factValue: T) => z.object({
  factType: z.literal(factType),
  factValue,
}).strict();

export const ProfileFactInputSchema = z.discriminatedUnion("factType", [
  factValueFor("skill", namedValue),
  factValueFor("certification", namedValue),
  factValueFor("language", languageValue),
  factValueFor("experience", summaryValue),
  factValueFor("education", summaryValue),
  factValueFor("project", summaryValue),
  factValueFor("achievement", summaryValue),
  factValueFor("work_eligibility", summaryValue),
]);

export const CandidateFactDecisionCommandSchema = z.discriminatedUnion("decision", [
  z.object({ expectedVersion: version, decision: z.literal("confirmed") }).strict(),
  z.object({ expectedVersion: version, decision: z.literal("rejected") }).strict(),
  z.object({
    expectedVersion: version,
    decision: z.literal("corrected"),
    factValue: ProfileFactValueSchema,
    reason,
  }).strict(),
]);

export const CreateProfileFactCommandSchema = z.object({ expectedVersion: version })
  .and(ProfileFactInputSchema);

export const ReviseProfileFactCommandSchema = z.object({
  expectedVersion: version,
  factValue: ProfileFactValueSchema,
  reason,
}).strict();

export const RemoveProfileFactCommandSchema = z.object({
  expectedVersion: version,
  reason,
}).strict();

export const ProfileFactSchema = z.discriminatedUnion("factType", [
  z.object({ factId: z.uuid(), revisionId: z.uuid(), source: z.enum(["candidate_fact", "user_confirmed"]), candidateFactId: z.uuid().nullable(), createdAt: z.iso.datetime() }).extend(factValueFor("skill", namedValue).shape).strict(),
  z.object({ factId: z.uuid(), revisionId: z.uuid(), source: z.enum(["candidate_fact", "user_confirmed"]), candidateFactId: z.uuid().nullable(), createdAt: z.iso.datetime() }).extend(factValueFor("certification", namedValue).shape).strict(),
  z.object({ factId: z.uuid(), revisionId: z.uuid(), source: z.enum(["candidate_fact", "user_confirmed"]), candidateFactId: z.uuid().nullable(), createdAt: z.iso.datetime() }).extend(factValueFor("language", languageValue).shape).strict(),
  z.object({ factId: z.uuid(), revisionId: z.uuid(), source: z.enum(["candidate_fact", "user_confirmed"]), candidateFactId: z.uuid().nullable(), createdAt: z.iso.datetime() }).extend(factValueFor("experience", summaryValue).shape).strict(),
  z.object({ factId: z.uuid(), revisionId: z.uuid(), source: z.enum(["candidate_fact", "user_confirmed"]), candidateFactId: z.uuid().nullable(), createdAt: z.iso.datetime() }).extend(factValueFor("education", summaryValue).shape).strict(),
  z.object({ factId: z.uuid(), revisionId: z.uuid(), source: z.enum(["candidate_fact", "user_confirmed"]), candidateFactId: z.uuid().nullable(), createdAt: z.iso.datetime() }).extend(factValueFor("project", summaryValue).shape).strict(),
  z.object({ factId: z.uuid(), revisionId: z.uuid(), source: z.enum(["candidate_fact", "user_confirmed"]), candidateFactId: z.uuid().nullable(), createdAt: z.iso.datetime() }).extend(factValueFor("achievement", summaryValue).shape).strict(),
  z.object({ factId: z.uuid(), revisionId: z.uuid(), source: z.literal("user_confirmed"), candidateFactId: z.null(), createdAt: z.iso.datetime() }).extend(factValueFor("work_eligibility", summaryValue).shape).strict(),
]);

export const ProfileSnapshotSchema = z.object({
  profileId: z.uuid().nullable(),
  version,
  facts: z.array(ProfileFactSchema),
}).strict();

export type ProfileFactType = z.infer<typeof ProfileFactTypeSchema>;
export type ImportedCandidateFactType = z.infer<typeof ImportedCandidateFactTypeSchema>;
export type ProfileFactValue = z.infer<typeof ProfileFactValueSchema>;
export type ProfileFactInput = z.infer<typeof ProfileFactInputSchema>;
export type CandidateFactDecisionCommand = z.infer<typeof CandidateFactDecisionCommandSchema>;
export type CreateProfileFactCommand = z.infer<typeof CreateProfileFactCommandSchema>;
export type ReviseProfileFactCommand = z.infer<typeof ReviseProfileFactCommandSchema>;
export type RemoveProfileFactCommand = z.infer<typeof RemoveProfileFactCommandSchema>;
export type ProfileFact = z.infer<typeof ProfileFactSchema>;
export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;

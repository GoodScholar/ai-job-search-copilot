import { z } from "zod";

const userString = z.string().trim().min(1).max(200);
const userStringList = z.array(userString).max(20).refine((values) => new Set(values).size === values.length, {
  message: "数组值必须唯一",
});
const version = z.int().min(0);
const positiveVersion = z.int().min(1);

const salary = z.object({
  minimum: z.int().nonnegative().nullable(),
  maximum: z.int().nonnegative().nullable(),
  period: z.enum(["month", "year"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict().refine(({ minimum, maximum }) => minimum === null || maximum === null || minimum <= maximum, {
  path: ["minimum"], message: "minimum must not exceed maximum",
});

export const JobTargetConstraintsSchema = z.object({
  roleFamily: userString,
  seniority: userString.nullable(),
  locations: userStringList,
  workModes: z.array(z.enum(["onsite", "hybrid", "remote"])).max(20).refine(
    (values) => new Set(values).size === values.length,
    { message: "数组值必须唯一" },
  ),
  relocation: z.enum(["unknown", "not_willing", "willing", "conditional"]),
  salary: salary.nullable(),
  industries: userStringList,
  dealBreakers: z.object({
    excludedCompanies: userStringList,
    excludedIndustries: userStringList,
    excludeOutsourcing: z.boolean(),
    excludeDispatch: z.boolean(),
    excludeHeadhunter: z.boolean(),
    other: userStringList,
  }).strict(),
}).strict();

export const JobTargetSuggestionSchema = z.object({
  suggestionId: z.uuid(),
  roleFamily: userString,
  rationale: userString,
  evidence: z.array(z.object({
    factId: z.uuid(), revisionId: z.uuid(), label: userString,
  }).strict()).max(20),
}).strict();

export const JobTargetSchema = z.object({
  targetId: z.uuid(),
  version: positiveVersion,
  priority: z.enum(["primary", "secondary"]),
  state: z.enum(["active", "inactive"]),
  constraints: JobTargetConstraintsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const JobTargetOverviewSchema = z.object({
  suggestions: z.array(JobTargetSuggestionSchema).max(20),
  targets: z.array(JobTargetSchema).max(20),
}).strict();

export const CreateJobTargetCommandSchema = z.object({
  priority: z.enum(["primary", "secondary"]),
  constraints: JobTargetConstraintsSchema,
}).strict();

export const ReviseJobTargetCommandSchema = z.object({
  expectedVersion: positiveVersion,
  priority: z.enum(["primary", "secondary"]),
  constraints: JobTargetConstraintsSchema,
}).strict();

export const DeactivateJobTargetCommandSchema = z.object({
  expectedVersion: positiveVersion,
}).strict();

export type JobTargetConstraints = z.infer<typeof JobTargetConstraintsSchema>;
export type JobTargetSuggestion = z.infer<typeof JobTargetSuggestionSchema>;
export type JobTarget = z.infer<typeof JobTargetSchema>;
export type JobTargetOverview = z.infer<typeof JobTargetOverviewSchema>;
export type CreateJobTargetCommand = z.infer<typeof CreateJobTargetCommandSchema>;
export type ReviseJobTargetCommand = z.infer<typeof ReviseJobTargetCommandSchema>;
export type DeactivateJobTargetCommand = z.infer<typeof DeactivateJobTargetCommandSchema>;

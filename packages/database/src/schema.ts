import { sql } from "drizzle-orm";
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const jobAccounts = pgTable("job_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const externalIdentities = pgTable("external_identities", {
  provider: varchar("provider", { length: 32 }).notNull(),
  subject: varchar("subject", { length: 128 }).notNull(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.provider, table.subject] })]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => jobAccounts.id),
  actorUserId: uuid("actor_user_id").references(() => jobAccounts.id),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  requestId: uuid("request_id").notNull(),
  outcome: varchar("outcome", { length: 32 }).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }).notNull(),
  resourceType: varchar("resource_type", { length: 64 }),
  resourceId: uuid("resource_id"),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const careerDocuments = pgTable("career_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
  objectKey: varchar("object_key", { length: 512 }).notNull(),
  originalFilename: varchar("original_filename", { length: 255 }).notNull(),
  sourceFormat: varchar("source_format", { length: 16 }).notNull().default("markdown"),
  mediaType: varchar("media_type", { length: 32 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  privacyScanVersion: varchar("privacy_scan_version", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("career_documents_user_checksum_source_format_unique").on(table.userId, table.checksumSha256, table.sourceFormat),
  unique("career_documents_user_id_id_unique").on(table.userId, table.id),
  check("career_documents_checksum_sha256_format", sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
  check("career_documents_media_type_check", sql`${table.mediaType} in ('text/markdown', 'text/plain')`),
  check("career_documents_source_format_check", sql`${table.sourceFormat} in ('markdown', 'docx', 'pdf')`),
  check("career_documents_source_format_media_type_check", sql`(${table.sourceFormat} = 'markdown' and ${table.mediaType} = 'text/markdown') or (${table.sourceFormat} in ('docx', 'pdf') and ${table.mediaType} = 'text/plain')`),
  check("career_documents_byte_size_range", sql`${table.byteSize} between 0 and 524288`),
]);

export const protectedCareerDocuments = pgTable("protected_career_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  processingDocumentId: uuid("processing_document_id").notNull().references(() => careerDocuments.id),
  checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
  objectKey: varchar("object_key", { length: 512 }).notNull(),
  originalFilename: varchar("original_filename", { length: 255 }).notNull(),
  mediaType: varchar("media_type", { length: 128 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("protected_career_documents_derivation_unique").on(
    table.userId, table.processingDocumentId, table.checksumSha256,
  ),
  foreignKey({
    columns: [table.userId, table.processingDocumentId],
    foreignColumns: [careerDocuments.userId, careerDocuments.id],
    name: "protected_career_documents_owner_processing_fk",
  }),
  check("protected_career_documents_checksum_format", sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
  check("protected_career_documents_media_type_check", sql`${table.mediaType} in ('text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/pdf')`),
  check("protected_career_documents_byte_size_range", sql`${table.byteSize} between 0 and 524288`),
]);

export const careerImports = pgTable("career_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  careerDocumentId: uuid("career_document_id").notNull().references(() => careerDocuments.id),
  status: varchar("status", { length: 16 }).notNull().default("queued"),
  parserAdapter: varchar("parser_adapter", { length: 32 }).notNull().default("fake"),
  parserVersion: varchar("parser_version", { length: 64 }).notNull().default("fake-career-parser-v1"),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull().default("career-import-prompt-v1"),
  outputSchemaVersion: varchar("output_schema_version", { length: 64 }).notNull().default("career-facts-v1"),
  attemptCount: integer("attempt_count").notNull().default(0),
  failureCode: varchar("failure_code", { length: 64 }),
  originatingRequestId: uuid("originating_request_id").notNull(),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("career_imports_document_versions_unique").on(
    table.careerDocumentId, table.parserVersion, table.promptVersion, table.outputSchemaVersion,
  ),
  unique("career_imports_user_id_id_document_id_unique").on(table.userId, table.id, table.careerDocumentId),
  foreignKey({
    columns: [table.userId, table.careerDocumentId],
    foreignColumns: [careerDocuments.userId, careerDocuments.id],
    name: "career_imports_owner_document_fk",
  }),
  check("career_imports_status_check", sql`${table.status} in ('queued', 'processing', 'completed', 'failed')`),
  check("career_imports_parser_adapter_check", sql`${table.parserAdapter} = 'fake'`),
  check("career_imports_parser_version_check", sql`${table.parserVersion} = 'fake-career-parser-v1'`),
  check("career_imports_prompt_version_check", sql`${table.promptVersion} = 'career-import-prompt-v1'`),
  check("career_imports_output_schema_version_check", sql`${table.outputSchemaVersion} = 'career-facts-v1'`),
  check("career_imports_attempt_count_check", sql`${table.attemptCount} >= 0`),
]);

export const candidateFacts = pgTable("candidate_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  careerImportId: uuid("career_import_id").notNull().references(() => careerImports.id),
  careerDocumentId: uuid("career_document_id").notNull().references(() => careerDocuments.id),
  factKey: varchar("fact_key", { length: 64 }).notNull(),
  factType: varchar("fact_type", { length: 32 }).notNull(),
  factValue: jsonb("fact_value").notNull(),
  confidenceBasisPoints: integer("confidence_basis_points").notNull(),
  confirmationStatus: varchar("confirmation_status", { length: 16 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("candidate_facts_import_fact_key_unique").on(table.careerImportId, table.factKey),
  unique("candidate_facts_user_id_id_unique").on(table.userId, table.id),
  unique("candidate_facts_user_id_id_document_id_unique").on(table.userId, table.id, table.careerDocumentId),
  foreignKey({
    columns: [table.userId, table.careerImportId, table.careerDocumentId],
    foreignColumns: [careerImports.userId, careerImports.id, careerImports.careerDocumentId],
    name: "candidate_facts_owner_import_document_fk",
  }),
  check("candidate_facts_fact_key_format", sql`${table.factKey} ~ '^[0-9a-f]{64}$'`),
  check("candidate_facts_fact_type_check", sql`${table.factType} in ('experience', 'education', 'skill', 'project', 'language', 'achievement', 'certification')`),
  check("candidate_facts_confidence_basis_points_range", sql`${table.confidenceBasisPoints} between 0 and 10000`),
  check("candidate_facts_confirmation_status_check", sql`${table.confirmationStatus} = 'pending'`),
]);

export const jobProfiles = pgTable("job_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_profiles_user_unique").on(table.userId),
  unique("job_profiles_user_id_id_unique").on(table.userId, table.id),
  check("job_profiles_version_nonnegative", sql`${table.version} >= 0`),
]);

export const profileFacts = pgTable("profile_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  profileId: uuid("profile_id").notNull().references(() => jobProfiles.id),
  factType: varchar("fact_type", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("profile_facts_user_id_id_unique").on(table.userId, table.id),
  foreignKey({
    columns: [table.userId, table.profileId],
    foreignColumns: [jobProfiles.userId, jobProfiles.id],
    name: "profile_facts_owner_profile_fk",
  }),
  check("profile_facts_fact_type_check", sql`${table.factType} in ('experience', 'education', 'skill', 'project', 'language', 'achievement', 'certification', 'work_eligibility')`),
]);

export const profileFactRevisions = pgTable("profile_fact_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  profileFactId: uuid("profile_fact_id").notNull().references(() => profileFacts.id),
  revisionNumber: integer("revision_number").notNull(),
  factType: varchar("fact_type", { length: 32 }).notNull(),
  factValue: jsonb("fact_value").notNull(),
  state: varchar("state", { length: 16 }).notNull().default("active"),
  source: varchar("source", { length: 32 }).notNull(),
  candidateFactId: uuid("candidate_fact_id").references(() => candidateFacts.id),
  reason: text("reason"),
  profileVersion: integer("profile_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("profile_fact_revisions_fact_revision_unique").on(table.profileFactId, table.revisionNumber),
  unique("profile_fact_revisions_user_id_id_unique").on(table.userId, table.id),
  foreignKey({
    columns: [table.userId, table.profileFactId],
    foreignColumns: [profileFacts.userId, profileFacts.id],
    name: "profile_fact_revisions_owner_fact_fk",
  }),
  foreignKey({
    columns: [table.userId, table.candidateFactId],
    foreignColumns: [candidateFacts.userId, candidateFacts.id],
    name: "profile_fact_revisions_owner_candidate_fk",
  }),
  check("profile_fact_revisions_number_positive", sql`${table.revisionNumber} >= 1`),
  check("profile_fact_revisions_fact_type_check", sql`${table.factType} in ('experience', 'education', 'skill', 'project', 'language', 'achievement', 'certification', 'work_eligibility')`),
  check("profile_fact_revisions_state_check", sql`${table.state} in ('active', 'removed')`),
  check("profile_fact_revisions_source_check", sql`${table.source} in ('candidate_fact', 'user_confirmed')`),
  check("profile_fact_revisions_profile_version_positive", sql`${table.profileVersion} >= 1`),
  check("profile_fact_revisions_candidate_source_check", sql`${table.source} != 'candidate_fact' or ${table.candidateFactId} is not null`),
]);

export const candidateFactDecisions = pgTable("candidate_fact_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  profileId: uuid("profile_id").notNull().references(() => jobProfiles.id),
  candidateFactId: uuid("candidate_fact_id").notNull().references(() => candidateFacts.id),
  decision: varchar("decision", { length: 16 }).notNull(),
  profileFactRevisionId: uuid("profile_fact_revision_id").references(() => profileFactRevisions.id),
  profileVersion: integer("profile_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("candidate_fact_decisions_candidate_fact_unique").on(table.candidateFactId),
  foreignKey({
    columns: [table.userId, table.profileId],
    foreignColumns: [jobProfiles.userId, jobProfiles.id],
    name: "candidate_fact_decisions_owner_profile_fk",
  }),
  foreignKey({
    columns: [table.userId, table.candidateFactId],
    foreignColumns: [candidateFacts.userId, candidateFacts.id],
    name: "candidate_fact_decisions_owner_candidate_fk",
  }),
  foreignKey({
    columns: [table.userId, table.profileFactRevisionId],
    foreignColumns: [profileFactRevisions.userId, profileFactRevisions.id],
    name: "candidate_fact_decisions_owner_revision_fk",
  }),
  check("candidate_fact_decisions_type_check", sql`${table.decision} in ('confirmed', 'corrected', 'rejected')`),
  check("candidate_fact_decisions_version_nonnegative", sql`${table.profileVersion} >= 0`),
  check("candidate_fact_decisions_revision_check", sql`(${table.decision} = 'rejected') = (${table.profileFactRevisionId} is null)`),
]);

export const candidateFactEvidence = pgTable("candidate_fact_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  candidateFactId: uuid("candidate_fact_id").notNull().references(() => candidateFacts.id),
  careerDocumentId: uuid("career_document_id").notNull().references(() => careerDocuments.id),
  locatorType: varchar("locator_type", { length: 32 }).notNull().default("markdown_lines"),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  excerpt: text("excerpt").notNull(),
  excerptSha256: varchar("excerpt_sha256", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("candidate_fact_evidence_fact_unique").on(table.candidateFactId),
  foreignKey({
    columns: [table.userId, table.candidateFactId, table.careerDocumentId],
    foreignColumns: [candidateFacts.userId, candidateFacts.id, candidateFacts.careerDocumentId],
    name: "candidate_fact_evidence_owner_fact_document_fk",
  }),
  check("candidate_fact_evidence_locator_type_check", sql`${table.locatorType} in ('markdown_lines', 'docx_paragraphs', 'pdf_pages')`),
  check("candidate_fact_evidence_start_line_check", sql`${table.startLine} >= 1`),
  check("candidate_fact_evidence_end_line_check", sql`${table.endLine} >= ${table.startLine}`),
  check("candidate_fact_evidence_excerpt_sha256_format", sql`${table.excerptSha256} ~ '^[0-9a-f]{64}$'`),
]);

export const careerFactConflicts = pgTable("career_fact_conflicts", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  existingCandidateFactId: uuid("existing_candidate_fact_id").notNull().references(() => candidateFacts.id), incomingCandidateFactId: uuid("incoming_candidate_fact_id").notNull().references(() => candidateFacts.id),
  kind: varchar("kind", { length: 32 }).notNull(), status: varchar("status", { length: 16 }).notNull().default("pending"), resolution: varchar("resolution", { length: 32 }), profileVersion: integer("profile_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [
  unique("career_fact_conflicts_pair_unique").on(table.existingCandidateFactId, table.incomingCandidateFactId),
  foreignKey({ columns: [table.userId, table.existingCandidateFactId], foreignColumns: [candidateFacts.userId, candidateFacts.id], name: "career_fact_conflicts_existing_owner_fk" }),
  foreignKey({ columns: [table.userId, table.incomingCandidateFactId], foreignColumns: [candidateFacts.userId, candidateFacts.id], name: "career_fact_conflicts_incoming_owner_fk" }),
  check("career_fact_conflicts_kind_check", sql`${table.kind} in ('date', 'role', 'organization', 'metric')`),
  check("career_fact_conflicts_status_check", sql`${table.status} in ('pending', 'resolved')`),
  check("career_fact_conflicts_resolution_check", sql`${table.resolution} is null or ${table.resolution} in ('use_existing', 'use_incoming', 'keep_both')`),
  check("career_fact_conflicts_profile_version_positive", sql`${table.profileVersion} is null or ${table.profileVersion} >= 1`),
  check("career_fact_conflicts_distinct_pair_check", sql`${table.existingCandidateFactId} <> ${table.incomingCandidateFactId}`),
  check("career_fact_conflicts_resolution_state_check", sql`(${table.status} = 'pending' and ${table.resolution} is null and ${table.resolvedAt} is null and ${table.profileVersion} is null) or (${table.status} = 'resolved' and ${table.resolution} is not null and ${table.resolvedAt} is not null and ${table.profileVersion} is not null)`),
]);

export const jobTargets = pgTable("job_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  version: integer("version").notNull(),
  priority: varchar("priority", { length: 16 }).notNull(),
  state: varchar("state", { length: 16 }).notNull().default("active"),
  activeSlot: integer("active_slot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_targets_user_id_id_unique").on(table.userId, table.id),
  uniqueIndex("job_targets_active_primary_per_user_unique").on(table.userId).where(sql`${table.priority} = 'primary' and ${table.state} = 'active'`),
  uniqueIndex("job_targets_active_secondary_slot_per_user_unique").on(table.userId, table.activeSlot).where(sql`${table.priority} = 'secondary' and ${table.state} = 'active'`),
  check("job_targets_version_positive", sql`${table.version} >= 1`),
  check("job_targets_priority_check", sql`${table.priority} in ('primary', 'secondary')`),
  check("job_targets_state_check", sql`${table.state} in ('active', 'inactive')`),
  check("job_targets_active_secondary_slot_check", sql`(${table.priority} = 'secondary' and ${table.state} = 'active' and ${table.activeSlot} is not null and ${table.activeSlot} in (1, 2)) or ((${table.priority} <> 'secondary' or ${table.state} <> 'active') and ${table.activeSlot} is null)`),
]);

export const jobTargetRevisions = pgTable("job_target_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  targetId: uuid("target_id").notNull().references(() => jobTargets.id),
  version: integer("version").notNull(),
  priority: varchar("priority", { length: 16 }).notNull(),
  state: varchar("state", { length: 16 }).notNull(),
  constraints: jsonb("constraints").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_target_revisions_target_version_unique").on(table.targetId, table.version),
  foreignKey({
    columns: [table.userId, table.targetId],
    foreignColumns: [jobTargets.userId, jobTargets.id],
    name: "job_target_revisions_owner_target_fk",
  }),
  check("job_target_revisions_version_positive", sql`${table.version} >= 1`),
  check("job_target_revisions_priority_check", sql`${table.priority} in ('primary', 'secondary')`),
  check("job_target_revisions_state_check", sql`${table.state} in ('active', 'inactive')`),
  check("job_target_revisions_constraints_object", sql`jsonb_typeof(${table.constraints}) = 'object'`),
]);

export const jobImports = pgTable("job_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  inputType: varchar("input_type", { length: 32 }).notNull(),
  contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
  originalFilename: varchar("original_filename", { length: 255 }),
  status: varchar("status", { length: 16 }).notNull().default("imported"),
  failureCode: varchar("failure_code", { length: 64 }),
  claimToken: uuid("claim_token"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_imports_user_content_unique").on(table.userId, table.contentSha256),
  unique("job_imports_user_id_id_unique").on(table.userId, table.id),
  check("job_imports_input_type_check", sql`${table.inputType} in ('pasted_text', 'markdown_upload')`),
  check("job_imports_status_check", sql`${table.status} in ('imported', 'normalizing', 'completed', 'failed')`),
  check("job_imports_content_sha256_format", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
  check("job_imports_filename_input_type_check", sql`(${table.inputType} = 'markdown_upload') = (${table.originalFilename} is not null)`),
]);

export const jobSourcePostings = pgTable("job_source_postings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  sourceType: varchar("source_type", { length: 32 }).notNull(),
  sourceIdentifier: varchar("source_identifier", { length: 512 }).notNull(),
  sourceIdentity: jsonb("source_identity").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_source_postings_user_identity_unique").on(table.userId, table.sourceType, table.sourceIdentifier),
  unique("job_source_postings_user_id_id_unique").on(table.userId, table.id),
  check("job_source_postings_source_identity_object", sql`jsonb_typeof(${table.sourceIdentity}) = 'object'`),
]);

export const jobSourcePostingVersions = pgTable("job_source_posting_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  sourcePostingId: uuid("source_posting_id").notNull().references(() => jobSourcePostings.id),
  version: integer("version").notNull(),
  contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
  rawContentSha256: varchar("raw_content_sha256", { length: 64 }).notNull(),
  rawObjectReference: jsonb("raw_object_reference").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_source_posting_versions_posting_version_unique").on(table.sourcePostingId, table.version),
  unique("job_source_posting_versions_user_id_id_unique").on(table.userId, table.id),
  foreignKey({
    columns: [table.userId, table.sourcePostingId],
    foreignColumns: [jobSourcePostings.userId, jobSourcePostings.id],
    name: "job_source_posting_versions_owner_posting_fk",
  }),
  check("job_source_posting_versions_version_positive", sql`${table.version} >= 1`),
  check("job_source_posting_versions_content_sha256_format", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
  check("job_source_posting_versions_raw_content_sha256_format", sql`${table.rawContentSha256} ~ '^[0-9a-f]{64}$'`),
  check("job_source_posting_versions_raw_object_reference_object", sql`jsonb_typeof(${table.rawObjectReference}) = 'object'`),
]);

export const jobOpportunities = pgTable("job_opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  importId: uuid("import_id").notNull().references(() => jobImports.id),
  sourcePostingVersionId: uuid("source_posting_version_id").notNull().references(() => jobSourcePostingVersions.id),
  dedupKey: varchar("dedup_key", { length: 64 }).notNull(),
  company: text("company"),
  title: text("title"),
  location: text("location"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  deadline: timestamp("deadline", { withTimezone: true }),
  description: text("description"),
  normalizedData: jsonb("normalized_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_opportunities_user_dedup_unique").on(table.userId, table.dedupKey),
  unique("job_opportunities_user_id_id_unique").on(table.userId, table.id),
  foreignKey({
    columns: [table.userId, table.importId],
    foreignColumns: [jobImports.userId, jobImports.id],
    name: "job_opportunities_owner_import_fk",
  }),
  foreignKey({
    columns: [table.userId, table.sourcePostingVersionId],
    foreignColumns: [jobSourcePostingVersions.userId, jobSourcePostingVersions.id],
    name: "job_opportunities_owner_posting_version_fk",
  }),
  check("job_opportunities_dedup_key_format", sql`${table.dedupKey} ~ '^[0-9a-f]{64}$'`),
  check("job_opportunities_normalized_data_object", sql`jsonb_typeof(${table.normalizedData}) = 'object'`),
]);

export const jobOpportunitySources = pgTable("job_opportunity_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  opportunityId: uuid("opportunity_id").notNull().references(() => jobOpportunities.id),
  sourcePostingVersionId: uuid("source_posting_version_id").notNull().references(() => jobSourcePostingVersions.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_opportunity_sources_opportunity_version_unique").on(table.opportunityId, table.sourcePostingVersionId),
  unique("job_opportunity_sources_user_id_id_unique").on(table.userId, table.id),
  foreignKey({
    columns: [table.userId, table.opportunityId],
    foreignColumns: [jobOpportunities.userId, jobOpportunities.id],
    name: "job_opportunity_sources_owner_opportunity_fk",
  }),
  foreignKey({
    columns: [table.userId, table.sourcePostingVersionId],
    foreignColumns: [jobSourcePostingVersions.userId, jobSourcePostingVersions.id],
    name: "job_opportunity_sources_owner_posting_version_fk",
  }),
]);

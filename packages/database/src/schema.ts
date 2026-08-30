import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

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

export const companyWatchlists = pgTable("company_watchlists", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  targetId: uuid("target_id").notNull().references(() => jobTargets.id),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("company_watchlists_user_target_unique").on(table.userId, table.targetId),
  unique("company_watchlists_user_id_id_unique").on(table.userId, table.id),
  unique("company_watchlists_user_watchlist_target_unique").on(table.userId, table.id, table.targetId),
  foreignKey({
    columns: [table.userId, table.targetId],
    foreignColumns: [jobTargets.userId, jobTargets.id],
    name: "company_watchlists_owner_target_fk",
  }),
  check("company_watchlists_version_positive", sql`${table.version} >= 1`),
]);

export const companyWatchlistRevisions = pgTable("company_watchlist_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  watchlistId: uuid("watchlist_id").notNull(),
  targetId: uuid("target_id").notNull(),
  version: integer("version").notNull(),
  items: jsonb("items").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("company_watchlist_revisions_watchlist_version_unique").on(table.watchlistId, table.version),
  foreignKey({
    columns: [table.userId, table.watchlistId, table.targetId],
    foreignColumns: [companyWatchlists.userId, companyWatchlists.id, companyWatchlists.targetId],
    name: "company_watchlist_revisions_watchlist_target_fk",
  }),
  foreignKey({
    columns: [table.userId, table.targetId],
    foreignColumns: [jobTargets.userId, jobTargets.id],
    name: "company_watchlist_revisions_owner_target_fk",
  }),
  check("company_watchlist_revisions_version_positive", sql`${table.version} >= 1`),
  check("company_watchlist_revisions_items_array", sql`jsonb_typeof(${table.items}) = 'array'`),
]);

export const jobImports = pgTable("job_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  inputType: varchar("input_type", { length: 32 }).notNull(),
  contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
  sourceIdentifier: varchar("source_identifier", { length: 64 }).notNull(),
  originalFilename: varchar("original_filename", { length: 255 }),
  requestedUrl: varchar("requested_url", { length: 2048 }),
  finalUrl: varchar("final_url", { length: 2048 }),
  canonicalUrl: varchar("canonical_url", { length: 2048 }),
  pageClassification: varchar("page_classification", { length: 32 }),
  sourceKind: varchar("source_kind", { length: 32 }),
  status: varchar("status", { length: 16 }).notNull().default("imported"),
  failureCode: varchar("failure_code", { length: 64 }),
  claimToken: uuid("claim_token"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("job_imports_user_non_url_content_unique").on(table.userId, table.contentSha256).where(sql`${table.inputType} <> 'url'`),
  uniqueIndex("job_imports_user_url_content_unique").on(table.userId, table.canonicalUrl, table.contentSha256).where(sql`${table.inputType} = 'url'`),
  unique("job_imports_user_id_id_unique").on(table.userId, table.id),
  check("job_imports_input_type_check", sql`${table.inputType} in ('pasted_text', 'markdown_upload', 'url')`),
  check("job_imports_status_check", sql`${table.status} in ('imported', 'normalizing', 'completed', 'failed')`),
  check("job_imports_content_sha256_format", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
  check("job_imports_source_identifier_format", sql`${table.sourceIdentifier} ~ '^[0-9a-f]{64}$'`),
  check("job_imports_filename_input_type_check", sql`(${table.inputType} = 'markdown_upload') = (${table.originalFilename} is not null)`),
  check("job_imports_url_provenance_check", sql`(${table.inputType} = 'url') = (${table.requestedUrl} is not null and ${table.finalUrl} is not null and ${table.canonicalUrl} is not null and ${table.pageClassification} = 'job' and ${table.sourceKind} in ('official', 'aggregator'))`),
]);

export const jobSourcePostings = pgTable("job_source_postings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  sourceType: varchar("source_type", { length: 32 }).notNull(),
  sourceIdentifier: varchar("source_identifier", { length: 512 }).notNull(),
  sourceId: varchar("source_id", { length: 2_048 }),
  sourceIdentity: jsonb("source_identity").notNull(),
  applicationDeadline: timestamp("application_deadline", { withTimezone: true }),
  isOfficial: boolean("is_official").notNull().default(false),
  availability: varchar("availability", { length: 16 }).notNull().default("open"),
  availabilityUpdatedAt: timestamp("availability_updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_source_postings_user_identity_unique").on(table.userId, table.sourceType, table.sourceIdentifier),
  unique("job_source_postings_user_id_id_unique").on(table.userId, table.id),
  index("job_source_postings_availability_idx").on(table.userId, table.availability, table.availabilityUpdatedAt),
  index("job_source_postings_source_scan_idx").on(table.userId, table.sourceType, table.sourceId, table.applicationDeadline),
  check("job_source_postings_source_identity_object", sql`jsonb_typeof(${table.sourceIdentity}) = 'object'`),
  check("job_source_postings_availability_check", sql`${table.availability} in ('open', 'closed', 'expired')`),
]);

export const jobSourcePostingVersions = pgTable("job_source_posting_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  sourcePostingId: uuid("source_posting_id").notNull().references(() => jobSourcePostings.id),
  version: integer("version").notNull(),
  contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
  rawContentSha256: varchar("raw_content_sha256", { length: 64 }).notNull(),
  rawObjectReference: jsonb("raw_object_reference").notNull(),
  normalizedData: jsonb("normalized_data").notNull().default({}),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  availability: varchar("availability", { length: 16 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_source_posting_versions_posting_version_unique").on(table.sourcePostingId, table.version),
  unique("job_source_posting_versions_user_id_id_unique").on(table.userId, table.id),
  index("job_source_posting_versions_availability_idx").on(table.userId, table.availability, table.createdAt, table.sourcePostingId),
  foreignKey({
    columns: [table.userId, table.sourcePostingId],
    foreignColumns: [jobSourcePostings.userId, jobSourcePostings.id],
    name: "job_source_posting_versions_owner_posting_fk",
  }),
  check("job_source_posting_versions_version_positive", sql`${table.version} >= 1`),
  check("job_source_posting_versions_content_sha256_format", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
  check("job_source_posting_versions_raw_content_sha256_format", sql`${table.rawContentSha256} ~ '^[0-9a-f]{64}$'`),
  check("job_source_posting_versions_raw_object_reference_object", sql`jsonb_typeof(${table.rawObjectReference}) = 'object'`),
  check("job_source_posting_versions_availability_check", sql`${table.availability} in ('open', 'closed', 'expired')`),
]);

export const jobOpportunities = pgTable("job_opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  importId: uuid("import_id").references(() => jobImports.id),
  sourcePostingVersionId: uuid("source_posting_version_id").notNull().references(() => jobSourcePostingVersions.id),
  canonicalOpportunityId: uuid("canonical_opportunity_id"),
  dedupKey: varchar("dedup_key", { length: 64 }).notNull(),
  company: text("company"),
  title: text("title"),
  location: text("location"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  deadline: timestamp("deadline", { withTimezone: true }),
  description: text("description"),
  normalizedData: jsonb("normalized_data").notNull(),
  availability: varchar("availability", { length: 16 }).notNull().default("open"),
  availabilityUpdatedAt: timestamp("availability_updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("job_opportunities_current_dedup_unique").on(table.userId, table.dedupKey).where(sql`${table.canonicalOpportunityId} is null`),
  unique("job_opportunities_user_id_id_unique").on(table.userId, table.id),
  index("job_opportunities_availability_idx").on(table.userId, table.availability, table.availabilityUpdatedAt),
  index("job_opportunities_canonical_idx").on(table.userId, table.canonicalOpportunityId),
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
  foreignKey({
    columns: [table.userId, table.canonicalOpportunityId],
    foreignColumns: [table.userId, table.id],
    name: "job_opportunities_owner_canonical_opportunity_fk",
  }),
  check("job_opportunities_dedup_key_format", sql`${table.dedupKey} ~ '^[0-9a-f]{64}$'`),
  check("job_opportunities_canonical_opportunity_not_self", sql`${table.canonicalOpportunityId} is null or ${table.canonicalOpportunityId} <> ${table.id}`),
  check("job_opportunities_normalized_data_object", sql`jsonb_typeof(${table.normalizedData}) = 'object'`),
  check("job_opportunities_availability_check", sql`${table.availability} in ('open', 'closed', 'expired')`),
]);

export const jobOpportunitySources = pgTable("job_opportunity_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  opportunityId: uuid("opportunity_id").notNull().references(() => jobOpportunities.id),
  sourcePostingVersionId: uuid("source_posting_version_id").notNull().references(() => jobSourcePostingVersions.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_opportunity_sources_opportunity_version_unique").on(table.opportunityId, table.sourcePostingVersionId),
  unique("job_opportunity_sources_evidence_tuple_unique").on(table.userId, table.opportunityId, table.sourcePostingVersionId),
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

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  targetId: uuid("target_id").notNull().references(() => jobTargets.id),
  idempotencyKey: uuid("idempotency_key").notNull(),
  targetVersion: integer("target_version").notNull(),
  targetSnapshot: jsonb("target_snapshot").notNull(),
  sourceScope: jsonb("source_scope").notNull(),
  budgetSnapshot: jsonb("budget_snapshot").notNull(),
  workflowVersion: varchar("workflow_version", { length: 64 }).notNull(),
  ruleVersion: varchar("rule_version", { length: 64 }).notNull(),
  adapter: varchar("adapter", { length: 64 }).notNull(),
  adapterVersion: varchar("adapter_version", { length: 64 }).notNull(),
  outputSchemaVersion: varchar("output_schema_version", { length: 64 }).notNull(),
  toolAllowlist: jsonb("tool_allowlist").notNull(),
  modelSnapshot: jsonb("model_snapshot"),
  status: varchar("status", { length: 16 }).notNull().default("queued"),
  currentStep: varchar("current_step", { length: 32 }).notNull().default("queued"),
  controlState: varchar("control_state", { length: 24 }).notNull().default("none"),
  version: integer("version").notNull().default(1),
  attemptCount: integer("attempt_count").notNull().default(0),
  activeSliceStartedAt: timestamp("active_slice_started_at", { withTimezone: true }),
  activeDurationMs: integer("active_duration_ms").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  sourceRequestCount: integer("source_request_count").notNull().default(0),
  modelCallCount: integer("model_call_count").notNull().default(0),
  inputTokenCount: integer("input_token_count").notNull().default(0),
  outputTokenCount: integer("output_token_count").notNull().default(0),
  totalTokenCount: integer("total_token_count").notNull().default(0),
  resultCount: integer("result_count").notNull().default(0),
  usageComplete: boolean("usage_complete").notNull().default(false),
  terminationKind: varchar("termination_kind", { length: 64 }),
  terminationBudgetDimension: varchar("termination_budget_dimension", { length: 32 }),
  retryOfRunId: uuid("retry_of_run_id"),
  failureCode: varchar("failure_code", { length: 64 }),
  claimToken: uuid("claim_token"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("agent_runs_user_id_id_unique").on(table.userId, table.id),
  unique("agent_runs_user_id_id_target_id_unique").on(table.userId, table.id, table.targetId),
  unique("agent_runs_user_idempotency_unique").on(table.userId, table.idempotencyKey),
  index("agent_runs_recovery_status_expiry_idx").on(table.status, table.claimExpiresAt, table.queuedAt, table.id),
  foreignKey({ columns: [table.userId, table.targetId], foreignColumns: [jobTargets.userId, jobTargets.id], name: "agent_runs_owner_target_fk" }),
  foreignKey({ columns: [table.userId, table.retryOfRunId], foreignColumns: [table.userId, table.id], name: "agent_runs_owner_retry_fk" }),
  check("agent_runs_target_version_positive", sql`${table.targetVersion} >= 1`),
  check("agent_runs_target_snapshot_object", sql`jsonb_typeof(${table.targetSnapshot}) = 'object'`),
  check("agent_runs_source_scope_object", sql`jsonb_typeof(${table.sourceScope}) = 'object'`),
  check("agent_runs_budget_snapshot_object", sql`jsonb_typeof(${table.budgetSnapshot}) = 'object'`),
  check("agent_runs_status_check", sql`${table.status} in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')`),
  check("agent_runs_current_step_check", sql`${table.currentStep} in ('queued', 'batch_search', 'fetch_details', 'persist_results', 'completed', 'failed', 'cancelled')`),
  check("agent_runs_control_state_check", sql`${table.controlState} in ('none', 'pause_requested', 'cancel_requested')`),
  check("agent_runs_version_positive", sql`${table.version} >= 1`),
  check("agent_runs_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
  check("agent_runs_failure_code_check", sql`${table.failureCode} is null or ${table.failureCode} in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE')`),
  check("agent_runs_claim_consistency_check", sql`(${table.claimToken} is null) = (${table.claimExpiresAt} is null)`),
  check("agent_runs_execution_claim_check", sql`(${table.claimToken} is null and ${table.claimExpiresAt} is null and ${table.activeSliceStartedAt} is null) or (${table.claimToken} is not null and ${table.claimExpiresAt} is not null and ${table.activeSliceStartedAt} is not null and ${table.status} = 'running')`),
  check("agent_runs_aggregate_nonnegative", sql`${table.activeDurationMs} >= 0 and ${table.toolCallCount} >= 0 and ${table.sourceRequestCount} >= 0 and ${table.modelCallCount} >= 0 and ${table.inputTokenCount} >= 0 and ${table.outputTokenCount} >= 0 and ${table.totalTokenCount} >= 0 and ${table.resultCount} >= 0`),
  check("agent_runs_total_tokens_check", sql`${table.totalTokenCount} = ${table.inputTokenCount} + ${table.outputTokenCount}`),
  check("agent_runs_fake_model_usage_check", sql`${table.modelSnapshot} is null and ${table.modelCallCount} = 0 and ${table.inputTokenCount} = 0 and ${table.outputTokenCount} = 0 and ${table.totalTokenCount} = 0`),
  check("agent_runs_termination_kind_check", sql`${table.terminationKind} is null or ${table.terminationKind} in ('completed', 'completed_with_source_issues', 'cancelled_by_user', 'source_failed', 'content_storage_failed', 'persistence_failed', 'budget_exhausted')`),
  check("agent_runs_termination_budget_dimension_check", sql`(${table.terminationKind} = 'budget_exhausted' and ${table.terminationBudgetDimension} in ('active_duration', 'attempts', 'tool_calls', 'model_calls', 'tokens')) or (${table.terminationKind} is distinct from 'budget_exhausted' and ${table.terminationBudgetDimension} is null)`),
  check("agent_runs_cancelled_step_check", sql`(${table.status} = 'cancelled') = (${table.currentStep} = 'cancelled')`),
  check("agent_runs_termination_mapping_check", sql`coalesce((
    (${table.status} in ('queued', 'running', 'paused') and ${table.terminationKind} is null and ${table.terminationBudgetDimension} is null)
    or (${table.status} = 'completed' and ((not ${table.usageComplete} and ${table.terminationKind} is null) or (${table.terminationKind} in ('completed', 'completed_with_source_issues') and ${table.failureCode} is null and ${table.terminationBudgetDimension} is null)))
    or (${table.status} = 'cancelled' and ((not ${table.usageComplete} and ${table.terminationKind} is null) or (${table.terminationKind} = 'cancelled_by_user' and ${table.failureCode} is null and ${table.terminationBudgetDimension} is null)))
    or (${table.status} = 'failed' and (
      (not ${table.usageComplete} and ${table.terminationKind} is null)
      or (${table.terminationKind} = 'source_failed' and ${table.failureCode} in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE') and ${table.terminationBudgetDimension} is null)
      or (${table.terminationKind} = 'content_storage_failed' and ${table.failureCode} = 'AGENT_RUN_CONTENT_STORAGE_FAILED' and ${table.terminationBudgetDimension} is null)
      or (${table.terminationKind} = 'persistence_failed' and ${table.failureCode} = 'AGENT_RUN_PERSIST_FAILED' and ${table.terminationBudgetDimension} is null)
      or (${table.terminationKind} = 'budget_exhausted' and ${table.failureCode} = 'AGENT_RUN_BUDGET_EXCEEDED' and ${table.terminationBudgetDimension} is not null)
    ))
  ), false)`),
  check("agent_runs_timestamp_state_check", sql`
    (${table.status} in ('queued', 'paused') and ${table.completedAt} is null and ${table.failedAt} is null and ${table.cancelledAt} is null)
    or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.completedAt} is null and ${table.failedAt} is null and ${table.cancelledAt} is null)
    or (${table.status} = 'completed' and ${table.startedAt} is not null and ${table.completedAt} is not null and ${table.failedAt} is null and ${table.cancelledAt} is null)
    or (${table.status} = 'failed' and ${table.startedAt} is not null and ${table.completedAt} is null and ${table.failedAt} is not null and ${table.cancelledAt} is null)
    or (${table.status} = 'cancelled' and ${table.completedAt} is null and ${table.failedAt} is null and ${table.cancelledAt} is not null)
  `),
]);

export const jobDiscoveryLeads = pgTable("job_discovery_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  runId: uuid("run_id").notNull(),
  targetId: uuid("target_id").notNull(),
  provider: varchar("provider", { length: 32 }).notNull(),
  queryId: uuid("query_id").notNull(),
  queryKind: varchar("query_kind", { length: 32 }).notNull(),
  queryFingerprint: varchar("query_fingerprint", { length: 64 }).notNull(),
  normalizedUrl: varchar("normalized_url", { length: 2_048 }).notNull(),
  stableFingerprint: varchar("stable_fingerprint", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  state: varchar("state", { length: 16 }).notNull().default("pending"),
  sourcePostingVersionId: uuid("source_posting_version_id"),
  rejectionCode: varchar("rejection_code", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_discovery_leads_owner_run_provider_identity_unique").on(table.userId, table.runId, table.provider, table.stableFingerprint),
  unique("job_discovery_leads_user_id_id_unique").on(table.userId, table.id),
  unique("job_discovery_leads_attr_ref_unique").on(table.userId, table.id, table.runId, table.provider, table.queryId, table.sourcePostingVersionId),
  index("job_discovery_leads_owner_run_state_idx").on(table.userId, table.runId, table.state, table.createdAt, table.id),
  foreignKey({
    columns: [table.userId, table.runId, table.targetId],
    foreignColumns: [agentRuns.userId, agentRuns.id, agentRuns.targetId],
    name: "job_discovery_leads_owner_run_target_fk",
  }),
  foreignKey({
    columns: [table.userId, table.sourcePostingVersionId],
    foreignColumns: [jobSourcePostingVersions.userId, jobSourcePostingVersions.id],
    name: "job_discovery_leads_owner_version_fk",
  }),
  check("job_discovery_leads_provider_check", sql`${table.provider} = 'anysearch'`),
  check("job_discovery_leads_query_kind_check", sql`${table.queryKind} in ('general', 'site_constrained', 'target_company')`),
  check("job_discovery_leads_query_fingerprint_format", sql`${table.queryFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("job_discovery_leads_stable_fingerprint_format", sql`${table.stableFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("job_discovery_leads_url_length_check", sql`length(${table.normalizedUrl}) between 1 and 2048`),
  check("job_discovery_leads_ttl_check", sql`${table.expiresAt} = ${table.createdAt} + interval '30 days'`),
  check("job_discovery_leads_state_check", sql`${table.state} in ('pending', 'verified', 'rejected')`),
  check("job_discovery_leads_rejection_code_check", sql`${table.rejectionCode} is null or ${table.rejectionCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`),
  check("job_discovery_leads_outcome_check", sql`
    (${table.state} = 'pending' and ${table.sourcePostingVersionId} is null and ${table.rejectionCode} is null)
    or (${table.state} = 'verified' and ${table.sourcePostingVersionId} is not null and ${table.rejectionCode} is null)
    or (${table.state} = 'rejected' and ${table.sourcePostingVersionId} is null and ${table.rejectionCode} is not null)
  `),
]);

export const jobDiscoveryAttributions = pgTable("job_discovery_attributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  runId: uuid("run_id").notNull(),
  leadId: uuid("lead_id").notNull(),
  queryId: uuid("query_id").notNull(),
  provider: varchar("provider", { length: 32 }).notNull(),
  sourcePostingVersionId: uuid("source_posting_version_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_discovery_attributions_lead_unique").on(table.leadId),
  unique("job_discovery_attributions_user_id_id_unique").on(table.userId, table.id),
  index("job_discovery_attributions_owner_run_idx").on(table.userId, table.runId, table.createdAt, table.id),
  foreignKey({
    columns: [table.userId, table.leadId, table.runId, table.provider, table.queryId, table.sourcePostingVersionId],
    foreignColumns: [jobDiscoveryLeads.userId, jobDiscoveryLeads.id, jobDiscoveryLeads.runId, jobDiscoveryLeads.provider, jobDiscoveryLeads.queryId, jobDiscoveryLeads.sourcePostingVersionId],
    name: "job_discovery_attributions_lead_ref_fk",
  }),
  foreignKey({
    columns: [table.userId, table.sourcePostingVersionId],
    foreignColumns: [jobSourcePostingVersions.userId, jobSourcePostingVersions.id],
    name: "job_discovery_attributions_owner_version_fk",
  }),
  check("job_discovery_attributions_provider_check", sql`${table.provider} = 'anysearch'`),
]);

export const jobDiscoverySchedules = pgTable("job_discovery_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  targetId: uuid("target_id").notNull().references(() => jobTargets.id),
  version: integer("version").notNull(),
  state: varchar("state", { length: 16 }).notNull().default("disabled"),
  dailyTime: varchar("daily_time", { length: 5 }).notNull(),
  timeZone: varchar("time_zone", { length: 32 }).notNull().default("Asia/Shanghai"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_discovery_schedules_user_target_unique").on(table.userId, table.targetId),
  unique("job_discovery_schedules_user_id_id_unique").on(table.userId, table.id),
  unique("job_discovery_schedules_user_schedule_target_unique").on(table.userId, table.id, table.targetId),
  index("job_discovery_schedules_due_idx").on(table.state, table.nextRunAt, table.id),
  foreignKey({
    columns: [table.userId, table.targetId],
    foreignColumns: [jobTargets.userId, jobTargets.id],
    name: "job_discovery_schedules_owner_target_fk",
  }),
  check("job_discovery_schedules_version_positive", sql`${table.version} >= 1`),
  check("job_discovery_schedules_state_check", sql`${table.state} in ('enabled', 'disabled')`),
  check("job_discovery_schedules_daily_time_check", sql`${table.dailyTime} ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("job_discovery_schedules_time_zone_check", sql`${table.timeZone} = 'Asia/Shanghai'`),
]);

export const jobDiscoveryScheduleOccurrences = pgTable("job_discovery_schedule_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  scheduleId: uuid("schedule_id").notNull(),
  targetId: uuid("target_id").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  runId: uuid("run_id"),
  skipReason: varchar("skip_reason", { length: 32 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_discovery_schedule_occurrences_schedule_time_unique").on(table.scheduleId, table.scheduledFor),
  unique("job_discovery_schedule_occurrences_user_id_id_unique").on(table.userId, table.id),
  index("job_discovery_schedule_occurrences_pending_idx").on(table.status, table.scheduledFor, table.id),
  foreignKey({
    columns: [table.userId, table.scheduleId, table.targetId],
    foreignColumns: [jobDiscoverySchedules.userId, jobDiscoverySchedules.id, jobDiscoverySchedules.targetId],
    name: "job_discovery_schedule_occurrences_owner_schedule_fk",
  }),
  foreignKey({
    columns: [table.userId, table.runId],
    foreignColumns: [agentRuns.userId, agentRuns.id],
    name: "job_discovery_schedule_occurrences_owner_run_fk",
  }),
  check("job_discovery_schedule_occurrences_status_check", sql`${table.status} in ('pending', 'dispatched', 'skipped')`),
  check("job_discovery_schedule_occurrences_skip_reason_check", sql`${table.skipReason} is null or ${table.skipReason} in ('TARGET_INACTIVE', 'NO_SUPPORTED_SOURCE', 'SOURCE_POLICY_REQUIRED')`),
  check("job_discovery_schedule_occurrences_outcome_check", sql`
    (${table.status} = 'pending' and ${table.runId} is null and ${table.skipReason} is null)
    or (${table.status} = 'dispatched' and ${table.runId} is not null and ${table.skipReason} is null)
    or (${table.status} = 'skipped' and ${table.runId} is null and ${table.skipReason} is not null)
  `),
]);

export const agentRunControlCommands = pgTable("agent_run_control_commands", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  runId: uuid("run_id").notNull().references(() => agentRuns.id), commandId: uuid("command_id").notNull(),
  action: varchar("action", { length: 16 }).notNull(), applied: boolean("applied").notNull(),
  resultRunVersion: integer("result_run_version").notNull(), resultSnapshot: jsonb("result_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("agent_run_control_commands_user_run_command_unique").on(table.userId, table.runId, table.commandId),
  foreignKey({ columns: [table.userId, table.runId], foreignColumns: [agentRuns.userId, agentRuns.id], name: "agent_run_control_commands_owner_run_fk" }),
  check("agent_run_control_commands_action_check", sql`${table.action} in ('pause', 'resume', 'cancel')`),
  check("agent_run_control_commands_result_version_positive", sql`${table.resultRunVersion} >= 1`),
  check("agent_run_control_commands_result_snapshot_object", sql`jsonb_typeof(${table.resultSnapshot}) = 'object'`),
  check("agent_run_control_commands_result_snapshot_check", sql`
    ${table.resultSnapshot} ?& array['runId', 'status', 'currentStep', 'controlState', 'version']
    and (${table.resultSnapshot} - array['runId', 'status', 'currentStep', 'controlState', 'version']) = '{}'::jsonb
    and jsonb_typeof(${table.resultSnapshot} -> 'runId') = 'string'
    and ${table.resultSnapshot} -> 'runId' = to_jsonb(${table.runId}::text)
    and jsonb_typeof(${table.resultSnapshot} -> 'status') = 'string'
    and ${table.resultSnapshot} ->> 'status' in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')
    and jsonb_typeof(${table.resultSnapshot} -> 'currentStep') = 'string'
    and ${table.resultSnapshot} ->> 'currentStep' in ('queued', 'batch_search', 'fetch_details', 'persist_results', 'completed', 'failed', 'cancelled')
    and ((${table.resultSnapshot} ->> 'status' = 'cancelled') = (${table.resultSnapshot} ->> 'currentStep' = 'cancelled'))
    and jsonb_typeof(${table.resultSnapshot} -> 'controlState') = 'string'
    and ${table.resultSnapshot} ->> 'controlState' in ('none', 'pause_requested', 'cancel_requested')
    and jsonb_typeof(${table.resultSnapshot} -> 'version') = 'number'
    and ${table.resultSnapshot} -> 'version' = to_jsonb(${table.resultRunVersion})
  `),
]);

export const agentRunUsageEntries = pgTable("agent_run_usage_entries", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  runId: uuid("run_id").notNull().references(() => agentRuns.id), usageKey: varchar("usage_key", { length: 128 }).notNull(),
  category: varchar("category", { length: 32 }).notNull(), amount: integer("amount").notNull(), stepKey: varchar("step_key", { length: 32 }),
  attemptCount: integer("attempt_count").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("agent_run_usage_entries_run_key_category_unique").on(table.runId, table.usageKey, table.category),
  foreignKey({ columns: [table.userId, table.runId], foreignColumns: [agentRuns.userId, agentRuns.id], name: "agent_run_usage_entries_owner_run_fk" }),
  check("agent_run_usage_entries_category_check", sql`${table.category} in ('active_duration', 'tool_call', 'source_request', 'model_call', 'input_tokens', 'output_tokens', 'result')`),
  check("agent_run_usage_entries_amount_positive", sql`${table.amount} >= 1`),
  check("agent_run_usage_entries_attempt_nonnegative", sql`${table.attemptCount} >= 0`),
  check("agent_run_usage_entries_step_check", sql`${table.stepKey} is null or ${table.stepKey} in ('batch_search', 'fetch_details', 'persist_results')`),
]);

export const agentInboxItems = pgTable("agent_inbox_items", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  runId: uuid("run_id").notNull().references(() => agentRuns.id), triggerEventSequence: integer("trigger_event_sequence").notNull(),
  kind: varchar("kind", { length: 32 }).notNull(), status: varchar("status", { length: 16 }).notNull().default("open"),
  reasonCode: varchar("reason_code", { length: 64 }).notNull(), budgetDimension: varchar("budget_dimension", { length: 32 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [
  unique("agent_inbox_items_user_id_id_unique").on(table.userId, table.id),
  unique("agent_inbox_items_run_event_kind_unique").on(table.runId, table.triggerEventSequence, table.kind),
  index("agent_inbox_items_open_lookup_idx").on(table.userId, table.status, table.createdAt),
  foreignKey({ columns: [table.userId, table.runId], foreignColumns: [agentRuns.userId, agentRuns.id], name: "agent_inbox_items_owner_run_fk" }),
  check("agent_inbox_items_trigger_event_positive", sql`${table.triggerEventSequence} >= 1`),
  check("agent_inbox_items_kind_check", sql`${table.kind} in ('run_failed', 'budget_exhausted', 'decision_required', 'source_attention')`),
  check("agent_inbox_items_status_check", sql`${table.status} in ('open', 'resolved')`),
  check("agent_inbox_items_reason_check", sql`${table.reasonCode} in ('AGENT_RUN_PAUSED', 'SOURCE_HEALTH_ATTENTION', 'AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED', 'AGENT_RUN_MODEL_RETRYABLE', 'AGENT_RUN_MODEL_AUTH_FAILED', 'AGENT_RUN_MODEL_POLICY_REJECTED', 'AGENT_RUN_MODEL_INVALID_RESPONSE')`),
  check("agent_inbox_items_kind_reason_pair_check", sql`(${table.kind} = 'source_attention') = (${table.reasonCode} = 'SOURCE_HEALTH_ATTENTION')`),
  check("agent_inbox_items_dimension_check", sql`${table.budgetDimension} is null or ${table.budgetDimension} in ('active_duration', 'attempts', 'tool_calls', 'model_calls', 'tokens')`),
  check("agent_inbox_items_resolved_check", sql`(${table.status} = 'open') = (${table.resolvedAt} is null)`),
]);

export const agentInboxItemActions = pgTable("agent_inbox_item_actions", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  itemId: uuid("item_id").notNull().references(() => agentInboxItems.id), actionId: uuid("action_id").notNull(),
  action: varchar("action", { length: 16 }).notNull(), outcome: varchar("outcome", { length: 16 }).notNull(),
  relatedRunId: uuid("related_run_id"), reasonCode: varchar("reason_code", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("agent_inbox_item_actions_user_item_action_unique").on(table.userId, table.itemId, table.actionId),
  foreignKey({ columns: [table.userId, table.itemId], foreignColumns: [agentInboxItems.userId, agentInboxItems.id], name: "agent_inbox_item_actions_owner_item_fk" }),
  foreignKey({ columns: [table.userId, table.relatedRunId], foreignColumns: [agentRuns.userId, agentRuns.id], name: "agent_inbox_item_actions_owner_related_run_fk" }),
  check("agent_inbox_item_actions_action_check", sql`${table.action} in ('restart_run', 'resume_run', 'cancel_run', 'dismiss')`),
  check("agent_inbox_item_actions_outcome_check", sql`${table.outcome} in ('pending', 'applied', 'no_change', 'failed')`),
]);

export const agentRunSteps = pgTable("agent_run_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  runId: uuid("run_id").notNull().references(() => agentRuns.id),
  stepKey: varchar("step_key", { length: 32 }).notNull(),
  ordinal: integer("ordinal").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  failureCode: varchar("failure_code", { length: 64 }),
}, (table) => [
  unique("agent_run_steps_user_id_id_unique").on(table.userId, table.id),
  unique("agent_run_steps_run_step_unique").on(table.runId, table.stepKey),
  unique("agent_run_steps_run_ordinal_unique").on(table.runId, table.ordinal),
  foreignKey({ columns: [table.userId, table.runId], foreignColumns: [agentRuns.userId, agentRuns.id], name: "agent_run_steps_owner_run_fk" }),
  check("agent_run_steps_step_key_check", sql`${table.stepKey} in ('batch_search', 'fetch_details', 'persist_results')`),
  check("agent_run_steps_ordinal_check", sql`${table.ordinal} between 1 and 3`),
  check("agent_run_steps_status_check", sql`${table.status} in ('pending', 'running', 'completed', 'failed')`),
  check("agent_run_steps_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
  check("agent_run_steps_failure_code_check", sql`${table.failureCode} is null or ${table.failureCode} in ('AGENT_RUN_ADAPTER_RETRYABLE', 'AGENT_RUN_ADAPTER_FAILED', 'AGENT_RUN_CONTENT_STORAGE_FAILED', 'AGENT_RUN_PERSIST_FAILED', 'AGENT_RUN_BUDGET_EXCEEDED')`),
  check("agent_run_steps_timestamp_state_check", sql`
    (${table.status} = 'pending' and ${table.startedAt} is null and ${table.completedAt} is null and ${table.failedAt} is null)
    or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.completedAt} is null and ${table.failedAt} is null)
    or (${table.status} = 'completed' and ${table.startedAt} is not null and ${table.completedAt} is not null and ${table.failedAt} is null)
    or (${table.status} = 'failed' and ${table.startedAt} is not null and ${table.completedAt} is null and ${table.failedAt} is not null)
  `),
]);

export const agentRunEvents = pgTable("agent_run_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  runId: uuid("run_id").notNull().references(() => agentRuns.id),
  sequence: integer("sequence").notNull(),
  runVersion: integer("run_version").notNull(),
  eventType: varchar("event_type", { length: 32 }).notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("agent_run_events_user_id_id_unique").on(table.userId, table.id),
  unique("agent_run_events_run_sequence_unique").on(table.runId, table.sequence),
  foreignKey({ columns: [table.userId, table.runId], foreignColumns: [agentRuns.userId, agentRuns.id], name: "agent_run_events_owner_run_fk" }),
  check("agent_run_events_sequence_positive", sql`${table.sequence} >= 1`),
  check("agent_run_events_run_version_positive", sql`${table.runVersion} >= 1`),
  check("agent_run_events_event_type_check", sql`${table.eventType} in ('run.queued', 'run.started', 'step.started', 'step.completed', 'run.retry_scheduled', 'run.completed', 'run.failed', 'run.pause_requested', 'run.paused', 'run.resume_requested', 'run.resumed', 'run.cancel_requested', 'run.cancelled', 'run.budget_updated')`),
  check("agent_run_events_data_object", sql`jsonb_typeof(${table.data}) = 'object'`),
]);

export const agentRunJobResults = pgTable("agent_run_job_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  runId: uuid("run_id").notNull().references(() => agentRuns.id),
  opportunityId: uuid("opportunity_id").notNull().references(() => jobOpportunities.id),
  sourcePostingVersionId: uuid("source_posting_version_id").notNull().references(() => jobSourcePostingVersions.id),
  ordinal: integer("ordinal").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("agent_run_job_results_user_id_id_unique").on(table.userId, table.id),
  unique("agent_run_job_results_run_opportunity_source_unique").on(table.runId, table.opportunityId, table.sourcePostingVersionId),
  unique("agent_run_job_results_run_ordinal_unique").on(table.runId, table.ordinal),
  foreignKey({ columns: [table.userId, table.runId], foreignColumns: [agentRuns.userId, agentRuns.id], name: "agent_run_job_results_owner_run_fk" }),
  foreignKey({ columns: [table.userId, table.opportunityId], foreignColumns: [jobOpportunities.userId, jobOpportunities.id], name: "agent_run_job_results_owner_opportunity_fk" }),
  foreignKey({ columns: [table.userId, table.sourcePostingVersionId], foreignColumns: [jobSourcePostingVersions.userId, jobSourcePostingVersions.id], name: "agent_run_job_results_owner_posting_version_fk" }),
  foreignKey({
    columns: [table.userId, table.opportunityId, table.sourcePostingVersionId],
    foreignColumns: [jobOpportunitySources.userId, jobOpportunitySources.opportunityId, jobOpportunitySources.sourcePostingVersionId],
    name: "agent_run_job_results_evidence_tuple_fk",
  }),
  check("agent_run_job_results_ordinal_positive", sql`${table.ordinal} >= 1`),
]);

export const jobSourceHealthChecks = pgTable("job_source_health_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  runId: uuid("run_id").notNull(),
  targetId: uuid("target_id").notNull(),
  watchlistItemId: uuid("watchlist_item_id").notNull(),
  sourceId: varchar("source_id", { length: 2_048 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  reasonCodes: jsonb("reason_codes").notNull(),
  impactScope: varchar("impact_scope", { length: 32 }).notNull(),
  impactAffectedCount: integer("impact_affected_count"),
  observedPostingCount: integer("observed_posting_count").notNull(),
  selectedDetailCount: integer("selected_detail_count").notNull(),
  validDetailCount: integer("valid_detail_count").notNull(),
  requestAttemptCount: integer("request_attempt_count").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("job_source_health_checks_run_source_unique").on(table.runId, table.sourceId),
  unique("job_source_health_checks_user_id_id_unique").on(table.userId, table.id),
  index("job_source_health_checks_latest_lookup_idx").on(table.userId, table.targetId, table.watchlistItemId, table.sourceId, table.checkedAt, table.id),
  foreignKey({
    columns: [table.userId, table.runId, table.targetId],
    foreignColumns: [agentRuns.userId, agentRuns.id, agentRuns.targetId],
    name: "job_source_health_checks_owner_run_target_fk",
  }),
  check("job_source_health_checks_status_check", sql`${table.status} in ('healthy', 'zero_valid_results', 'parser_degraded', 'rate_limited', 'hard_failed')`),
  check("job_source_health_checks_reason_codes_array_check", sql`jsonb_typeof(${table.reasonCodes}) = 'array'`),
  check("job_source_health_checks_reason_codes_safe_check", sql`${table.reasonCodes} <@ '["SOURCE_LIST_SCHEMA_INVALID", "SOURCE_DETAIL_FIELDS_MISSING", "SOURCE_DETAIL_URL_INVALID", "SOURCE_DETAIL_IDENTITY_INVALID", "SOURCE_RATE_LIMITED", "SOURCE_AUTH_FAILED", "SOURCE_TIMEOUT", "SOURCE_UNREACHABLE", "SOURCE_SERVER_ERROR", "SOURCE_POLICY_REJECTED"]'::jsonb`),
  check("job_source_health_checks_source_id_check", sql`${table.sourceId} ~ '^greenhouse:[A-Za-z0-9_-]{1,128}$'`),
  check("job_source_health_checks_impact_scope_check", sql`(${table.impactScope} = 'none' and ${table.impactAffectedCount} is null) or (${table.impactScope} = 'job_details' and ${table.impactAffectedCount} >= 1) or (${table.impactScope} = 'entire_source' and (${table.impactAffectedCount} is null or ${table.impactAffectedCount} >= 0))`),
  check("job_source_health_checks_counts_nonnegative", sql`${table.observedPostingCount} >= 0 and ${table.selectedDetailCount} >= 0 and ${table.validDetailCount} >= 0 and ${table.requestAttemptCount} >= 1 and ${table.validDetailCount} <= ${table.selectedDetailCount} and ${table.selectedDetailCount} <= ${table.observedPostingCount}`),
  check("job_source_health_checks_status_evidence_check", sql`
    (${table.status} = 'healthy' and ${table.validDetailCount} >= 1 and ${table.reasonCodes} = '[]'::jsonb and ${table.impactScope} = 'none' and ${table.impactAffectedCount} is null)
    or (${table.status} = 'zero_valid_results' and ${table.validDetailCount} = 0 and ${table.reasonCodes} = '[]'::jsonb and ${table.impactScope} = 'none' and ${table.impactAffectedCount} is null)
    or (${table.status} = 'parser_degraded' and ${table.reasonCodes} <> '[]'::jsonb and ${table.reasonCodes} <@ '["SOURCE_LIST_SCHEMA_INVALID", "SOURCE_DETAIL_FIELDS_MISSING", "SOURCE_DETAIL_URL_INVALID", "SOURCE_DETAIL_IDENTITY_INVALID"]'::jsonb and ${table.impactScope} in ('job_details', 'entire_source'))
    or (${table.status} = 'rate_limited' and ${table.reasonCodes} = '["SOURCE_RATE_LIMITED"]'::jsonb and ${table.impactScope} = 'entire_source')
    or (${table.status} = 'hard_failed' and ${table.reasonCodes} <> '[]'::jsonb and ${table.reasonCodes} <@ '["SOURCE_AUTH_FAILED", "SOURCE_TIMEOUT", "SOURCE_UNREACHABLE", "SOURCE_SERVER_ERROR", "SOURCE_POLICY_REJECTED"]'::jsonb and ${table.impactScope} = 'entire_source')
  `),
]);

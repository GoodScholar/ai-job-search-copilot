import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

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
  mediaType: varchar("media_type", { length: 32 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("career_documents_user_checksum_unique").on(table.userId, table.checksumSha256),
  check("career_documents_checksum_sha256_format", sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
  check("career_documents_media_type_check", sql`${table.mediaType} = 'text/markdown'`),
  check("career_documents_byte_size_range", sql`${table.byteSize} between 0 and 524288`),
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
  check("candidate_facts_fact_key_format", sql`${table.factKey} ~ '^[0-9a-f]{64}$'`),
  check("candidate_facts_fact_type_check", sql`${table.factType} in ('experience', 'education', 'skill', 'project', 'language', 'achievement', 'certification')`),
  check("candidate_facts_confidence_basis_points_range", sql`${table.confidenceBasisPoints} between 0 and 10000`),
  check("candidate_facts_confirmation_status_check", sql`${table.confirmationStatus} = 'pending'`),
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
  check("candidate_fact_evidence_locator_type_check", sql`${table.locatorType} = 'markdown_lines'`),
  check("candidate_fact_evidence_start_line_check", sql`${table.startLine} >= 1`),
  check("candidate_fact_evidence_end_line_check", sql`${table.endLine} >= ${table.startLine}`),
  check("candidate_fact_evidence_excerpt_sha256_format", sql`${table.excerptSha256} ~ '^[0-9a-f]{64}$'`),
]);

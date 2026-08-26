import { jsonb, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

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
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
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

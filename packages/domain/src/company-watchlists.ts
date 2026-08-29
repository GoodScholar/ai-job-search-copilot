import { and, eq, sql } from "drizzle-orm";
import {
  companyWatchlistRevisions,
  companyWatchlists,
  jobTargetRevisions,
  jobTargets,
  type Database,
} from "@job-copilot/database";
import {
  AddCompanyWatchlistItemCommandSchema,
  CompanyWatchlistItemSchema,
  CompanyWatchlistOverviewSchema,
  ReorderCompanyWatchlistCommandSchema,
  ReviseCompanyWatchlistItemCommandSchema,
  SetCompanyWatchlistItemStateCommandSchema,
  type AddCompanyWatchlistItemCommand,
  type CompanyWatchlistItem,
  type CompanyWatchlistOverview,
  type ReorderCompanyWatchlistCommand,
  type ReviseCompanyWatchlistItemCommand,
  type SetCompanyWatchlistItemStateCommand,
} from "@job-copilot/contracts/company-watchlists";
import { JobTargetConstraintsSchema } from "@job-copilot/contracts/job-targets";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export class CompanyWatchlistError extends Error {
  constructor(public readonly code:
    | "COMPANY_WATCHLIST_TARGET_NOT_FOUND"
    | "COMPANY_WATCHLIST_TARGET_INACTIVE"
    | "COMPANY_WATCHLIST_ITEM_NOT_FOUND"
    | "COMPANY_WATCHLIST_VERSION_CONFLICT"
    | "COMPANY_WATCHLIST_LIMIT"
    | "COMPANY_WATCHLIST_DUPLICATE_COMPANY"
    | "COMPANY_WATCHLIST_DUPLICATE_SOURCE",
  ) {
    super(code);
  }
}

type Dependencies = { db: Database; auditTrail: AuditTrail; id: () => string; clock: () => Date };
type Mutation = (items: CompanyWatchlistItem[]) => CompanyWatchlistItem[];
type AuditAction = "item_added" | "item_revised" | "reordered" | "item_enabled" | "item_disabled";
type Target = { targetId: string; targetVersion: number; targetState: "active" | "inactive"; roleFamily: string };

async function loadTarget(db: Pick<Database, "select">, userId: string, targetId: string): Promise<Target> {
  const [target] = await db.select({
    targetId: jobTargets.id,
    targetVersion: jobTargets.version,
    targetState: jobTargets.state,
    constraints: jobTargetRevisions.constraints,
  }).from(jobTargets).innerJoin(jobTargetRevisions, and(
    eq(jobTargetRevisions.userId, jobTargets.userId),
    eq(jobTargetRevisions.targetId, jobTargets.id),
    eq(jobTargetRevisions.version, jobTargets.version),
  )).where(and(eq(jobTargets.userId, userId), eq(jobTargets.id, targetId)));
  if (!target) throw new CompanyWatchlistError("COMPANY_WATCHLIST_TARGET_NOT_FOUND");
  return {
    targetId: target.targetId,
    targetVersion: target.targetVersion,
    targetState: target.targetState as "active" | "inactive",
    roleFamily: JobTargetConstraintsSchema.parse(target.constraints).roleFamily,
  };
}

async function loadCurrent(db: Pick<Database, "select">, userId: string, targetId: string) {
  const [current] = await db.select({
    id: companyWatchlists.id,
    version: companyWatchlists.version,
    items: companyWatchlistRevisions.items,
  }).from(companyWatchlists).innerJoin(companyWatchlistRevisions, and(
    eq(companyWatchlistRevisions.userId, companyWatchlists.userId),
    eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id),
    eq(companyWatchlistRevisions.version, companyWatchlists.version),
  )).where(and(eq(companyWatchlists.userId, userId), eq(companyWatchlists.targetId, targetId)));
  if (!current) return { id: null, version: 0, items: [] as CompanyWatchlistItem[] };
  return { id: current.id, version: current.version, items: CompanyWatchlistItemSchema.array().parse(current.items) };
}

function overview(target: Target, version: number, items: CompanyWatchlistItem[]): CompanyWatchlistOverview {
  return CompanyWatchlistOverviewSchema.parse({ target, version, items });
}

function normalizedSource(url: string): string {
  return new URL(url).href;
}

function assertDistinct(items: CompanyWatchlistItem[]): void {
  const companyNames = new Set<string>();
  const sources = new Set<string>();
  for (const item of items) {
    const companyName = item.canonicalCompanyName.toLocaleLowerCase("en-US");
    if (companyNames.has(companyName)) throw new CompanyWatchlistError("COMPANY_WATCHLIST_DUPLICATE_COMPANY");
    companyNames.add(companyName);
    const source = normalizedSource(item.careersUrl);
    if (sources.has(source)) throw new CompanyWatchlistError("COMPANY_WATCHLIST_DUPLICATE_SOURCE");
    sources.add(source);
  }
}

export function createCompanyWatchlistQueries(deps: { db: Database }): {
  get(input: { userId: string; targetId: string }): Promise<CompanyWatchlistOverview>;
} {
  return {
    async get({ userId, targetId }) {
      const target = await loadTarget(deps.db, userId, targetId);
      const current = await loadCurrent(deps.db, userId, targetId);
      return overview(target, current.version, current.items);
    },
  };
}

export function createCompanyWatchlistCommands(deps: Dependencies): {
  addItem(input: { userId: string; requestId: string; targetId: string; command: AddCompanyWatchlistItemCommand }): Promise<CompanyWatchlistOverview>;
  reviseItem(input: { userId: string; requestId: string; targetId: string; itemId: string; command: ReviseCompanyWatchlistItemCommand }): Promise<CompanyWatchlistOverview>;
  reorder(input: { userId: string; requestId: string; targetId: string; command: ReorderCompanyWatchlistCommand }): Promise<CompanyWatchlistOverview>;
  setItemState(input: { userId: string; requestId: string; targetId: string; itemId: string; command: SetCompanyWatchlistItemStateCommand }): Promise<CompanyWatchlistOverview>;
} {
  async function mutate(input: {
    userId: string; requestId: string; targetId: string; expectedVersion: number; mutation: Mutation; action: AuditAction; itemId?: string;
  }): Promise<CompanyWatchlistOverview> {
    return deps.db.transaction(async (transaction) => {
      await acquireAccountAdvisoryLock(transaction, input.userId);
      const target = await loadTarget(transaction, input.userId, input.targetId);
      if (target.targetState !== "active") throw new CompanyWatchlistError("COMPANY_WATCHLIST_TARGET_INACTIVE");
      const current = await loadCurrent(transaction, input.userId, input.targetId);
      if (current.version !== input.expectedVersion) throw new CompanyWatchlistError("COMPANY_WATCHLIST_VERSION_CONFLICT");

      const items = input.mutation(current.items);
      assertDistinct(items);
      const nextVersion = current.version + 1;
      const result = overview(target, nextVersion, items);
      const updatedAt = deps.clock();
      const watchlistId = current.id ?? deps.id();

      if (current.id) {
        const [updated] = await transaction.update(companyWatchlists).set({
          version: sql`${companyWatchlists.version} + 1`, updatedAt,
        }).where(and(
          eq(companyWatchlists.userId, input.userId), eq(companyWatchlists.targetId, input.targetId), eq(companyWatchlists.version, current.version),
        )).returning({ id: companyWatchlists.id });
        if (!updated) throw new CompanyWatchlistError("COMPANY_WATCHLIST_VERSION_CONFLICT");
      } else {
        await transaction.insert(companyWatchlists).values({
          id: watchlistId, userId: input.userId, targetId: input.targetId, version: nextVersion, createdAt: updatedAt, updatedAt,
        });
      }

      await transaction.insert(companyWatchlistRevisions).values({
        id: deps.id(), userId: input.userId, watchlistId, targetId: input.targetId, version: nextVersion, items, createdAt: updatedAt,
      });
      const auditTrail = deps.auditTrail.bind(transaction);
      const auditBase = {
        userId: input.userId, actorUserId: input.userId, eventType: "profile.company_watchlist_maintained" as const, occurredAt: updatedAt,
        requestId: input.requestId, outcome: "success" as const, resourceType: "company_watchlist" as const, resourceId: input.targetId,
      };
      switch (input.action) {
        case "item_added":
          await auditTrail.append({ ...auditBase, reasonCode: "COMPANY_WATCHLIST_ITEM_ADDED", metadata: { targetId: input.targetId, action: "item_added", version: nextVersion, itemId: input.itemId!, itemCount: items.length } });
          break;
        case "item_revised":
          await auditTrail.append({ ...auditBase, reasonCode: "COMPANY_WATCHLIST_ITEM_REVISED", metadata: { targetId: input.targetId, action: "item_revised", version: nextVersion, itemId: input.itemId!, itemCount: items.length } });
          break;
        case "reordered":
          await auditTrail.append({ ...auditBase, reasonCode: "COMPANY_WATCHLIST_REORDERED", metadata: { targetId: input.targetId, action: "reordered", version: nextVersion, itemCount: items.length } });
          break;
        case "item_enabled":
          await auditTrail.append({ ...auditBase, reasonCode: "COMPANY_WATCHLIST_ITEM_ENABLED", metadata: { targetId: input.targetId, action: "item_enabled", version: nextVersion, itemId: input.itemId!, itemCount: items.length } });
          break;
        case "item_disabled":
          await auditTrail.append({ ...auditBase, reasonCode: "COMPANY_WATCHLIST_ITEM_DISABLED", metadata: { targetId: input.targetId, action: "item_disabled", version: nextVersion, itemId: input.itemId!, itemCount: items.length } });
          break;
      }
      return result;
    });
  }

  return {
    async addItem(input) {
      const command = AddCompanyWatchlistItemCommandSchema.parse(input.command);
      const { expectedVersion, ...editableFields } = command;
      const itemId = deps.id();
      return mutate({
        ...input, expectedVersion, action: "item_added", itemId,
        mutation: (items) => {
          if (items.length >= 50) throw new CompanyWatchlistError("COMPANY_WATCHLIST_LIMIT");
          return [...items, { ...editableFields, itemId, state: "enabled", position: items.length + 1 }];
        },
      });
    },
    async reviseItem(input) {
      const command = ReviseCompanyWatchlistItemCommandSchema.parse(input.command);
      const { expectedVersion, ...editableFields } = command;
      return mutate({
        ...input, expectedVersion, action: "item_revised", itemId: input.itemId,
        mutation: (items) => {
          if (!items.some(({ itemId }) => itemId === input.itemId)) throw new CompanyWatchlistError("COMPANY_WATCHLIST_ITEM_NOT_FOUND");
          return items.map((item) => item.itemId === input.itemId
            ? { ...editableFields, itemId: item.itemId, position: item.position, state: item.state }
            : item);
        },
      });
    },
    async reorder(input) {
      const command = ReorderCompanyWatchlistCommandSchema.parse(input.command);
      return mutate({
        ...input, expectedVersion: command.expectedVersion, action: "reordered",
        mutation: (items) => {
          if (command.orderedItemIds.length !== items.length || new Set(command.orderedItemIds).size !== items.length) {
            throw new CompanyWatchlistError("COMPANY_WATCHLIST_ITEM_NOT_FOUND");
          }
          const byId = new Map(items.map((item) => [item.itemId, item]));
          const ordered = command.orderedItemIds.map((itemId) => byId.get(itemId));
          if (ordered.some((item) => !item)) throw new CompanyWatchlistError("COMPANY_WATCHLIST_ITEM_NOT_FOUND");
          return ordered.map((item, index) => ({ ...item!, position: index + 1 }));
        },
      });
    },
    async setItemState(input) {
      const command = SetCompanyWatchlistItemStateCommandSchema.parse(input.command);
      return mutate({
        ...input, expectedVersion: command.expectedVersion, action: command.state === "enabled" ? "item_enabled" : "item_disabled", itemId: input.itemId,
        mutation: (items) => {
          if (!items.some(({ itemId }) => itemId === input.itemId)) throw new CompanyWatchlistError("COMPANY_WATCHLIST_ITEM_NOT_FOUND");
          return items.map((item) => item.itemId === input.itemId ? { ...item, state: command.state } : item);
        },
      });
    },
  };
}

export type CompanyWatchlistCommands = ReturnType<typeof createCompanyWatchlistCommands>;
export type CompanyWatchlistQueries = ReturnType<typeof createCompanyWatchlistQueries>;

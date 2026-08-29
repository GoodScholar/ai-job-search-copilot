import { describe, expect, it } from "vitest";
import {
  AddCompanyWatchlistItemCommandSchema,
  CompanyWatchlistOverviewSchema,
  ReorderCompanyWatchlistCommandSchema,
  ReviseCompanyWatchlistItemCommandSchema,
  SetCompanyWatchlistItemStateCommandSchema,
} from "./company-watchlists";

const targetId = "9d61c84e-4a04-4ca1-b1f0-4d1b89658836";
const firstItemId = "e384ef6d-7dc3-4e4e-8692-7d3199575716";
const secondItemId = "9d3c5f4c-43be-40dc-9c7c-c9b7896574d9";

const firstItem = {
  itemId: firstItemId,
  canonicalCompanyName: "Aurora Labs",
  careersUrl: "https://jobs.aurora.example/careers",
  allowedDomains: ["aurora.example"],
  sourceNote: "优先关注公开工程岗位",
  state: "enabled" as const,
  position: 1,
};

const addCommand = {
  expectedVersion: 0,
  canonicalCompanyName: "Aurora Labs",
  careersUrl: "https://jobs.aurora.example/careers",
  allowedDomains: ["aurora.example"],
  sourceNote: null,
};

describe("company watchlist contracts", () => {
  it("accepts the exact overview and command public shapes", () => {
    expect(CompanyWatchlistOverviewSchema.parse({
      target: {
        targetId,
        targetVersion: 1,
        targetState: "active",
        roleFamily: "后端工程师",
      },
      version: 1,
      items: [firstItem],
    })).toEqual({
      target: {
        targetId,
        targetVersion: 1,
        targetState: "active",
        roleFamily: "后端工程师",
      },
      version: 1,
      items: [firstItem],
    });
    expect(AddCompanyWatchlistItemCommandSchema.parse(addCommand)).toEqual(addCommand);
    expect(ReviseCompanyWatchlistItemCommandSchema.parse({ ...addCommand, expectedVersion: 1 }))
      .toEqual({ ...addCommand, expectedVersion: 1 });
    expect(ReorderCompanyWatchlistCommandSchema.parse({ expectedVersion: 1, orderedItemIds: [firstItemId] }))
      .toEqual({ expectedVersion: 1, orderedItemIds: [firstItemId] });
    expect(SetCompanyWatchlistItemStateCommandSchema.parse({ expectedVersion: 1, state: "disabled" }))
      .toEqual({ expectedVersion: 1, state: "disabled" });
  });

  it("enforces the watchlist bounds and strict command objects", () => {
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      canonicalCompanyName: " ",
    }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      canonicalCompanyName: "a".repeat(201),
    }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      sourceNote: "a".repeat(501),
    }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      allowedDomains: [],
    }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      allowedDomains: Array.from({ length: 21 }, (_, index) => `company-${index}.example`),
    }).success).toBe(false);
    expect(ReorderCompanyWatchlistCommandSchema.safeParse({
      expectedVersion: 1,
      orderedItemIds: Array.from({ length: 51 }, (_, index) => `a${index}84ef6d-7dc3-4e4e-8692-7d3199575716`),
    }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({ ...addCommand, expectedVersion: -1 }).success).toBe(false);
    expect(ReorderCompanyWatchlistCommandSchema.safeParse({
      expectedVersion: 1, orderedItemIds: [firstItemId], extra: true,
    }).success).toBe(false);
    expect(SetCompanyWatchlistItemStateCommandSchema.safeParse({
      expectedVersion: 1, state: "enabled", extra: true,
    }).success).toBe(false);

    for (const forbiddenField of ["username", "password", "cookie", "captchaBypass", "loginWallAuthorization"]) {
      expect(AddCompanyWatchlistItemCommandSchema.safeParse({
        ...addCommand,
        [forbiddenField]: "not allowed",
      }).success).toBe(false);
    }
  });

  it("requires unique item IDs and contiguous unique positions", () => {
    const secondItem = {
      ...firstItem,
      itemId: secondItemId,
      canonicalCompanyName: "Orbit Systems",
      careersUrl: "https://careers.orbit.example/openings",
      allowedDomains: ["orbit.example"],
      position: 2,
    };
    const overview = {
      target: { targetId, targetVersion: 1, targetState: "active" as const, roleFamily: "后端工程师" },
      version: 2,
      items: [firstItem, secondItem],
    };

    expect(CompanyWatchlistOverviewSchema.safeParse(overview).success).toBe(true);
    expect(CompanyWatchlistOverviewSchema.safeParse({
      ...overview,
      items: [firstItem, { ...secondItem, itemId: firstItemId }],
    }).success).toBe(false);
    expect(CompanyWatchlistOverviewSchema.safeParse({
      ...overview,
      items: [firstItem, { ...secondItem, position: 1 }],
    }).success).toBe(false);
    expect(CompanyWatchlistOverviewSchema.safeParse({
      ...overview,
      items: [firstItem, { ...secondItem, position: 3 }],
    }).success).toBe(false);
    expect(CompanyWatchlistOverviewSchema.safeParse({
      ...overview,
      items: [secondItem, firstItem],
    }).success).toBe(false);
    expect(CompanyWatchlistOverviewSchema.safeParse({ ...overview, version: 0 }).success).toBe(false);
    expect(CompanyWatchlistOverviewSchema.safeParse({
      ...overview,
      items: Array.from({ length: 51 }, (_, index) => ({
        ...firstItem,
        itemId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        position: index + 1,
      })),
    }).success).toBe(false);
  });

  it("requires a public careers URL hosted by an allowed domain without credentials", () => {
    for (const careersUrl of [
      "http://aurora.example/careers",
      "https://jobs.aurora.example/careers",
    ]) {
      expect(AddCompanyWatchlistItemCommandSchema.safeParse({ ...addCommand, careersUrl }).success).toBe(true);
    }

    for (const careersUrl of [
      "ftp://aurora.example/careers",
      "https://elsewhere.example/careers",
      "https://user:password@aurora.example/careers",
      "https://aurora.example/careers?access_token=secret",
      "https://aurora.example/careers?PASSWORD=secret",
      "https://aurora.example/careers?api_key=secret",
      "https://aurora.example/careers?client_secret=secret",
      "https://aurora.example/careers?secret_key=secret",
      "https://aurora.example/careers?auth_token=secret",
      "https://aurora.example/careers?clientSecret=secret",
      "https://localhost/careers",
      "https://[::1]/careers",
    ]) {
      expect(AddCompanyWatchlistItemCommandSchema.safeParse({ ...addCommand, careersUrl }).success).toBe(false);
    }

    const urlAtLimit = `https://aurora.example/${"a".repeat(2_025)}`;
    expect(urlAtLimit).toHaveLength(2_048);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({ ...addCommand, careersUrl: urlAtLimit }).success).toBe(true);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({ ...addCommand, careersUrl: `${urlAtLimit}a` }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      careersUrl: "https://aurora.example/careers?monkey=public",
    }).success).toBe(true);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      careersUrl: "https://127.0.0.1/careers",
      allowedDomains: ["127.0.0.1"],
    }).success).toBe(false);

    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      allowedDomains: ["https://aurora.example"],
    }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      allowedDomains: ["aurora.example:443"],
    }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      allowedDomains: ["*.aurora.example"],
    }).success).toBe(false);
    expect(AddCompanyWatchlistItemCommandSchema.safeParse({
      ...addCommand,
      allowedDomains: ["aurora.example", "aurora.example"],
    }).success).toBe(false);
  });
});

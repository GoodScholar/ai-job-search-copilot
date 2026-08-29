import { describe, expect, it } from "vitest";
import {
  GREENHOUSE_API_HOST,
  GreenhousePublicSourceSchema,
  JobDiscoveryScheduleOccurrenceSchema,
  JobDiscoveryScheduleSchema,
  SetJobDiscoveryScheduleCommandSchema,
  classifyGreenhousePublicSource,
} from "./job-discovery-schedules";

const scheduleId = "2cae603a-aac5-44e0-aac5-3fc43aa26136";
const targetId = "87a0d3ac-4aed-4bd5-a703-68bf82cc6c49";
const occurrenceId = "06a13a63-42c1-4f95-ae95-8d5e7e3b3560";
const runId = "1e764df5-19f3-49f3-b16e-512147298baa";
const now = "2026-08-30T00:00:00.000Z";

const schedule = {
  scheduleId,
  targetId,
  version: 1,
  state: "enabled" as const,
  dailyTime: "09:30",
  timeZone: "Asia/Shanghai" as const,
  nextRunAt: now,
  updatedAt: now,
};

const greenhouseCandidate = {
  itemId: "e384ef6d-7dc3-4e4e-8692-7d3199575716",
  canonicalCompanyName: "Aurora Labs",
  careersUrl: "https://boards.greenhouse.io/aurora",
  allowedDomains: ["boards.greenhouse.io", GREENHOUSE_API_HOST],
};

describe("job discovery schedule contracts", () => {
  it("parses the exact server-owned daily schedule and occurrence shapes", () => {
    expect(JobDiscoveryScheduleSchema.parse(schedule)).toEqual(schedule);
    expect(SetJobDiscoveryScheduleCommandSchema.parse({
      expectedVersion: 0, state: "enabled", dailyTime: "09:30",
    })).toEqual({ expectedVersion: 0, state: "enabled", dailyTime: "09:30" });
    expect(JobDiscoveryScheduleOccurrenceSchema.parse({
      occurrenceId, scheduleId, targetId, scheduledFor: now, status: "dispatched", runId, skipReason: null,
    })).toMatchObject({ occurrenceId, status: "dispatched", runId });
  });

  it("rejects client time zones, invalid daily times, invalid versions, and unknown fields", () => {
    for (const dailyTime of ["9:30", "24:00", "23:60", "09:3a", " 09:30 "]) {
      expect(SetJobDiscoveryScheduleCommandSchema.safeParse({ expectedVersion: 0, state: "enabled", dailyTime }).success).toBe(false);
    }
    expect(JobDiscoveryScheduleSchema.safeParse({ ...schedule, version: 0 }).success).toBe(false);
    expect(JobDiscoveryScheduleSchema.safeParse({ ...schedule, version: -1 }).success).toBe(false);
    expect(SetJobDiscoveryScheduleCommandSchema.safeParse({ expectedVersion: -1, state: "enabled", dailyTime: "09:30" }).success).toBe(false);
    expect(JobDiscoveryScheduleSchema.safeParse({ ...schedule, timeZone: "America/Los_Angeles" }).success).toBe(false);
    expect(SetJobDiscoveryScheduleCommandSchema.safeParse({ expectedVersion: 0, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai" }).success).toBe(false);
    expect(JobDiscoveryScheduleOccurrenceSchema.safeParse({
      occurrenceId, scheduleId, targetId, scheduledFor: now, status: "skipped", runId: null,
      skipReason: "SOURCE_POLICY_REQUIRED", unexpected: true,
    }).success).toBe(false);
  });

  it("classifies only exact-host-authorized one-token Greenhouse careers sources as supported", () => {
    const supported = classifyGreenhousePublicSource(greenhouseCandidate);
    if (supported.kind !== "supported") throw new Error("expected the valid Greenhouse candidate to be supported");
    expect(supported).toEqual({
      kind: "supported",
      source: {
        sourceId: "greenhouse:aurora",
        watchlistItemId: greenhouseCandidate.itemId,
        canonicalCompanyName: "Aurora Labs",
        careersUrl: "https://boards.greenhouse.io/aurora",
        allowedDomains: ["boards.greenhouse.io", GREENHOUSE_API_HOST],
        boardToken: "aurora",
      },
    });
    expect(GreenhousePublicSourceSchema.parse(supported.source)).toEqual(supported.source);

    expect(classifyGreenhousePublicSource({
      ...greenhouseCandidate,
      allowedDomains: ["boards.greenhouse.io", "greenhouse.io"],
    })).toEqual({ kind: "policy_required", code: "GREENHOUSE_API_HOST_NOT_ALLOWED" });
    for (const careersUrl of [
      "https://boards.greenhouse.io/aurora/jobs",
      "https://boards.greenhouse.io/",
      "https://greenhouse.io/aurora",
      "https://job-boards.greenhouse.io/aurora/extra",
    ]) {
      expect(classifyGreenhousePublicSource({ ...greenhouseCandidate, careersUrl }))
        .toEqual({ kind: "unsupported" });
    }
  });
});

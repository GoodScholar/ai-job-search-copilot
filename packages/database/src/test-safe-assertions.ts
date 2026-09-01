import { expect } from "vitest";

export function assertTrue(value: boolean): void {
  expect(value).toBe(true);
}

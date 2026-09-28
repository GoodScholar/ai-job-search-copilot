import { expect, it } from "vitest";

import { careerLensCaptureDirectory } from "./career-lens-capture";

it("does not select a screenshot directory unless capture is explicitly requested", () => {
  expect(careerLensCaptureDirectory(undefined)).toBeNull();
  expect(careerLensCaptureDirectory("unexpected")).toBeNull();
});

it("selects only the explicitly requested immutable review phase", () => {
  expect(careerLensCaptureDirectory("before")).toBe("before");
  expect(careerLensCaptureDirectory("after")).toBe("after");
});

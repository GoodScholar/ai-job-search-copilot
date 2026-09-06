import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("allows long source filenames to wrap inside profile facts", async () => {
  const css = await readFile(resolve(process.cwd(), "app/globals.css"), "utf8");

  expect(css).toMatch(/\.profile-facts-heading > div \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  expect(css).toMatch(/\.profile-fact-value span \{[^}]*overflow-wrap: anywhere;/);
});

it("declares the workbench navigation touch height once", async () => {
  const css = await readFile(resolve(process.cwd(), "app/globals.css"), "utf8");
  const rule = css.match(/\.workbench-nav-link,[\s\S]*?\n\}/)?.[0] ?? "";

  expect(rule.match(/min-height:\s*2\.75rem;/g)).toHaveLength(1);
});

it("keeps loading summary density aligned with seven summary facts and preserves reduced motion", async () => {
  const css = await readFile(resolve(process.cwd(), "app/globals.css"), "utf8");
  expect(css).toMatch(/\.workbench-loading-summary \{[^}]*grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
});

it("keeps the first recommendation journey compact on desktop and single-column through 720px", async () => {
  const css = await readFile(resolve(process.cwd(), "app/globals.css"), "utf8");

  expect(css).toMatch(/\.first-recommendation-journey \{[^}]*max-width:\s*45rem;/);
  expect(css).toMatch(/@media \(max-width: 720px\) \{[\s\S]*?\.first-recommendation-journey-heading \{[^}]*display:\s*grid;/);
  expect(css).toMatch(/@media \(max-width: 720px\) \{[\s\S]*?\.first-recommendation-journey-list \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
});

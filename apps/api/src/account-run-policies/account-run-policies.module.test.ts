import { expect, it } from "vitest";
import { ACCOUNT_RUN_CONTROL } from "./account-run-policies.tokens.js";
import { AccountRunPoliciesModule } from "./account-run-policies.module.js";

it("账户策略模块公开独立控制 provider，供认证控制器装配", () => {
  const providers = Reflect.getMetadata("providers", AccountRunPoliciesModule) as Array<{ provide?: symbol }>;
  expect(providers.some((provider) => provider.provide === ACCOUNT_RUN_CONTROL)).toBe(true);
});

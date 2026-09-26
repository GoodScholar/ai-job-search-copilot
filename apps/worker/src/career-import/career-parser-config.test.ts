import { describe, expect, it } from "vitest";
import { FakeCareerDocumentParser } from "./fake-career-document-parser.js";
import { createConfiguredCareerParser } from "./career-parser-config.js";

describe("career parser configuration", () => {
  it("默认和 CI 使用 Fake", () => {
    expect(createConfiguredCareerParser({ APP_ENV: "test" })).toBeInstanceOf(FakeCareerDocumentParser);
    expect(createConfiguredCareerParser({ APP_ENV: "development", OPENAI_API_KEY: "unused" })).toBeInstanceOf(FakeCareerDocumentParser);
  });

  it("只有显式配置生产模式与凭据才选择 OpenAI", () => {
    expect(() => createConfiguredCareerParser({ CAREER_PARSER_ADAPTER: "openai" })).toThrow("CAREER_PARSER_CREDENTIALS_MISSING");
    expect(createConfiguredCareerParser({ CAREER_PARSER_ADAPTER: "openai", OPENAI_API_KEY: "test-key" }).metadata)
      .toMatchObject({ adapter: "openai", model: "gpt-5.6-luna" });
  });
});

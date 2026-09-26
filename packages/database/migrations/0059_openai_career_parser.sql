ALTER TABLE "career_imports" ADD COLUMN "model" varchar(128);--> statement-breakpoint
ALTER TABLE "career_imports" DROP CONSTRAINT "career_imports_parser_adapter_check";--> statement-breakpoint
ALTER TABLE "career_imports" DROP CONSTRAINT "career_imports_parser_version_check";--> statement-breakpoint
ALTER TABLE "career_imports" ADD CONSTRAINT "career_imports_parser_adapter_check" CHECK ("career_imports"."parser_adapter" in ('fake', 'openai'));--> statement-breakpoint
ALTER TABLE "career_imports" ADD CONSTRAINT "career_imports_parser_version_check" CHECK (("career_imports"."parser_adapter" = 'fake' and "career_imports"."parser_version" = 'fake-career-parser-v1' and "career_imports"."model" is null) or ("career_imports"."parser_adapter" = 'openai' and "career_imports"."parser_version" ~ '^openai-career-parser-v1-[0-9a-f]{16}$' and "career_imports"."model" is not null and length("career_imports"."model") between 1 and 128));

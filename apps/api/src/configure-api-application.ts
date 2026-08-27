import multipart from "@fastify/multipart";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import { configureOpenApi } from "./api-documentation.js";

export async function configureApiApplication(app: NestFastifyApplication): Promise<void> {
  // Nest currently resolves Fastify 5.11 while the application pins Fastify 5.12;
  // the plugin runtime contract is compatible, but their duplicate type identities are not.
  await app.register(multipart as never, {
    limits: { files: 2, fields: 1, parts: 3, fileSize: CAREER_DOCUMENT_MAX_BYTES },
    throwFileSizeLimit: true,
  });
  configureOpenApi(app);
}

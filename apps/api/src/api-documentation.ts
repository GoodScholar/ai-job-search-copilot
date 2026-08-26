import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";

export function configureOpenApi(app: NestFastifyApplication): void {
  const document = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle("AI Job Search Copilot API")
    .setVersion("1")
    .build());
  SwaggerModule.setup("docs", app, cleanupOpenApiDoc(document), {
    jsonDocumentUrl: "/openapi.json",
    ui: false,
  });
}

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { configureOpenApi } from "./api-documentation.js";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  configureOpenApi(app);
  await app.listen(Number(process.env.API_PORT ?? 3021), "127.0.0.1");
}

void bootstrap();

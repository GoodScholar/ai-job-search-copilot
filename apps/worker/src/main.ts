import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const keepAlive = setInterval(() => undefined, 2 ** 31 - 1);
  const shutdown = async () => {
    clearInterval(keepAlive);
    await app.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void bootstrap();

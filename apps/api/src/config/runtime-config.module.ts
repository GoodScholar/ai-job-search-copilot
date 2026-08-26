import { Module } from "@nestjs/common";
import { createDatabase, type Database } from "@job-copilot/database";
import { parseRuntimeConfig, type RuntimeConfig } from "@job-copilot/domain/runtime-config";

export const RUNTIME_CONFIG = Symbol("RUNTIME_CONFIG");
export const DATABASE = Symbol("DATABASE");

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 必须配置");
  }
  return databaseUrl;
}

@Module({
  providers: [
    {
      provide: RUNTIME_CONFIG,
      useFactory: (): RuntimeConfig => parseRuntimeConfig({
        APP_ENV: process.env.APP_ENV,
        AUTH_MODE: process.env.AUTH_MODE,
        DEV_AUTH_SHARED_SECRET: process.env.DEV_AUTH_SHARED_SECRET,
      }),
    },
    {
      provide: DATABASE,
      useFactory: (): Database => createDatabase(getDatabaseUrl()),
    },
  ],
  exports: [RUNTIME_CONFIG, DATABASE],
})
export class RuntimeConfigModule {}

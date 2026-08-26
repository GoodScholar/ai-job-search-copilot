import { Controller, Get, Module } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get("live")
  live() {
    return { status: "ok" as const };
  }
}

@Module({
  controllers: [HealthController],
})
export class AppModule {}

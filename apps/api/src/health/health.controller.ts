import { Controller, Get, HttpStatus, Inject } from "@nestjs/common";
import { ApiException } from "../common/api-problem.filter.js";
import { checkReadiness, READINESS_CHECKS, type ReadinessDependencies } from "./readiness.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly readinessChecks: ReadinessDependencies) {}

  @Get("live")
  live() {
    return { status: "ok" as const };
  }

  @Get("ready")
  async ready() {
    const readiness = await checkReadiness(this.readinessChecks);
    if (readiness.status === "not_ready") {
      throw new ApiException(
        "RUNTIME_NOT_READY",
        HttpStatus.SERVICE_UNAVAILABLE,
        "运行依赖未就绪",
        { dependencies: readiness.dependencies },
      );
    }
    return readiness;
  }
}

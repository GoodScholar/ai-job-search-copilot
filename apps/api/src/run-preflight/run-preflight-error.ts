import { HttpStatus } from "@nestjs/common";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import { ApiException } from "../common/api-problem.filter.js";

export function runPreflightConflict(error: RunPreflightRejectedError): ApiException {
  return new ApiException(error.code, HttpStatus.CONFLICT, error.code === "RUN_PREFLIGHT_BLOCKED" ? "运行前检查未通过" : "请确认当前运行前检查提示", { preflight: error.report });
}

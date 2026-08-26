import type { GetWorkbenchHome } from "@job-copilot/domain/workbench-home";

export const WORKBENCH_HOME = Symbol("WORKBENCH_HOME");

export type WorkbenchHomeService = GetWorkbenchHome;

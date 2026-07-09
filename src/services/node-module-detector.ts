import {
  getProjectInformationFromRawData,
  type ModuleDetector,
  type ProjectInformation,
} from "@versu/core";
import { getRawProjectInformation } from "../node-project-information.js";

/**
 * Module detector for Node.js-based projects.
 * Parses package.json files to discover all workspace modules and their dependencies.
 */
export class NodeModuleDetector implements ModuleDetector {
  /** Absolute path to the repository root directory. */
  constructor(readonly repoRoot: string) {}

  async detect(): Promise<ProjectInformation> {
    const rawProjectInformation = await getRawProjectInformation(this.repoRoot);
    return getProjectInformationFromRawData(rawProjectInformation);
  }
}

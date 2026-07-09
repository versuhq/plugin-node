import * as fs from "fs/promises";
import { NODE_PACKAGE_FILE, NODE_ID } from "../constants.js";
import { type AdapterIdentifier, exists, logger } from "@versu/core";

/**
 * Adapter identifier for Node.js-based projects.
 * Detects Node.js projects by looking for package.json in the project root.
 */
export class NodeAdapterIdentifier implements AdapterIdentifier {
  /** Metadata describing this Node.js adapter (id: 'node', no snapshot support). */
  readonly metadata = {
    id: NODE_ID,
    capabilities: {
      supportsSnapshots: false,
    },
  };

  /**
   * Determines whether the specified project is a Node.js project.
   * @param projectRoot - Absolute path to the project root directory
   * @returns True if package.json is found in the project root
   */
  async accept(projectRoot: string): Promise<boolean> {
    const projectRootExists = await exists(projectRoot);

    if (!projectRootExists) {
      logger.debug("Project root does not exist", { projectRoot });
      return false;
    }

    const files = await fs.readdir(projectRoot);
    return files.includes(NODE_PACKAGE_FILE);
  }
}

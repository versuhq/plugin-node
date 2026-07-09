import type {
  ModuleDetector,
  ModuleRegistry,
  ModuleSystemFactory,
  VersionUpdateStrategy,
} from "@versu/core";
import { NodeModuleDetector } from "./node-module-detector.js";
import { NodeVersionUpdateStrategy } from "./node-version-update-strategy.js";

/**
 * Factory for creating Node.js-specific module system components.
 */
export class NodeModuleSystemFactory implements ModuleSystemFactory {
  /** Absolute path to the repository root directory. */
  constructor(private readonly repoRoot: string) {}

  async createDetector(_outputFile: string): Promise<ModuleDetector> {
    return new NodeModuleDetector(this.repoRoot);
  }

  async createVersionUpdateStrategy(
    moduleRegistry: ModuleRegistry,
  ): Promise<VersionUpdateStrategy> {
    return new NodeVersionUpdateStrategy(this.repoRoot, moduleRegistry);
  }
}

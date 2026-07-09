import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { ModuleRegistry, VersionUpdateStrategy } from "@versu/core";
import { NODE_PACKAGE_FILE } from "../constants.js";
import {
  DEPENDENCY_FIELDS,
  type PackageManifest,
} from "../node-project-information.js";

const WORKSPACE_PROTOCOL = "workspace:";

/** Matches simple pinned ranges: an optional ^/~ operator followed by a single version. */
const PINNED_RANGE_PATTERN = /^([\^~]?)\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

export class NodeVersionUpdateStrategy implements VersionUpdateStrategy {
  constructor(
    private readonly repoRoot: string,
    private readonly moduleRegistry: ModuleRegistry,
  ) {}

  async writeVersionUpdates(
    moduleVersions: Map<string, string>,
  ): Promise<void> {
    const updatedPackages = new Map<string, string>();

    for (const [moduleId, newVersion] of moduleVersions) {
      const module = this.moduleRegistry.getModule(moduleId);
      const packageName = module["packageName"] as string | undefined;
      if (packageName) {
        updatedPackages.set(packageName, newVersion);
      }
    }

    for (const module of this.moduleRegistry.getModules().values()) {
      const packageJsonPath =
        (module["packageJsonPath"] as string | undefined) ||
        join(this.repoRoot, module.path, NODE_PACKAGE_FILE);

      const moduleNewVersion = moduleVersions.get(module.id);
      const projectVersion =
        moduleNewVersion && module.declaredVersion
          ? moduleNewVersion
          : undefined;

      await this.updateManifest(packageJsonPath, projectVersion, updatedPackages);
    }
  }

  private async updateManifest(
    packageJsonPath: string,
    projectVersion: string | undefined,
    updatedPackages: Map<string, string>,
  ): Promise<void> {
    const content = await readFile(packageJsonPath, "utf8");
    const manifest = JSON.parse(content) as PackageManifest;
    let changed = false;

    if (projectVersion && manifest.version !== undefined) {
      manifest.version = projectVersion;
      changed = true;
    }

    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (!dependencies) continue;

      for (const [dependencyName, spec] of Object.entries(dependencies)) {
        const newVersion = updatedPackages.get(dependencyName);
        if (!newVersion) continue;

        const updatedSpec = updateDependencySpec(spec, newVersion);
        if (updatedSpec !== undefined && updatedSpec !== spec) {
          dependencies[dependencyName] = updatedSpec;
          changed = true;
        }
      }
    }

    if (!changed) return;

    const indent = detectIndent(content);
    const trailingNewline = content.endsWith("\n") ? "\n" : "";
    const updatedContent = JSON.stringify(manifest, null, indent) + trailingNewline;
    await writeFile(packageJsonPath, updatedContent, "utf8");
  }
}

/**
 * Rewrites a dependency spec to point at a new version, preserving the range
 * operator and the `workspace:` protocol prefix. Returns undefined when the
 * spec does not embed a concrete version (e.g. `*`, `workspace:^`, `file:`,
 * git/url specs, compound ranges) and must be left untouched.
 */
export function updateDependencySpec(
  spec: string,
  newVersion: string,
): string | undefined {
  if (spec.startsWith(WORKSPACE_PROTOCOL)) {
    const inner = spec.slice(WORKSPACE_PROTOCOL.length);
    const updatedInner = updateDependencySpec(inner, newVersion);
    return updatedInner === undefined
      ? undefined
      : `${WORKSPACE_PROTOCOL}${updatedInner}`;
  }

  const match = PINNED_RANGE_PATTERN.exec(spec);
  if (!match) return undefined;

  return `${match[1]}${newVersion}`;
}

function detectIndent(content: string): string {
  const match = /\n([ \t]+)"/.exec(content);
  return match?.[1] ?? "  ";
}

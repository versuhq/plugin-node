import { join, sep } from "path";
import fs from "fs/promises";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import {
  type BaseModule,
  exists,
  logger,
  type RawProjectInformation,
} from "@versu/core";
import { NODE_PACKAGE_FILE, PNPM_WORKSPACE_FILE } from "./constants.js";

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export type PackageManifest = {
  name?: string;
  version?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export type NodeModule = BaseModule & {
  packageJsonPath: string;
  packageName?: string;
};

type NodeProjectInformation = {
  [id: string]: NodeModule;
};

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function normalizePath(pathValue: string): string {
  return pathValue.split(sep).join("/").replace(/\/+$/, "") || ".";
}

function moduleIdFromPath(relPath: string): string {
  const normalized = normalizePath(relPath);
  return normalized === "." ? ":" : `:${normalized.split("/").join(":")}`;
}

async function readManifest(packageJsonPath: string): Promise<PackageManifest> {
  const content = await fs.readFile(packageJsonPath, "utf-8");
  return JSON.parse(content) as PackageManifest;
}

function workspaceGlobsFromManifest(manifest: PackageManifest): string[] {
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces;
  }
  return manifest.workspaces?.packages ?? [];
}

async function workspaceGlobsFromPnpm(projectRoot: string): Promise<string[]> {
  const pnpmWorkspacePath = join(projectRoot, PNPM_WORKSPACE_FILE);
  if (!(await exists(pnpmWorkspacePath))) return [];

  const content = await fs.readFile(pnpmWorkspacePath, "utf-8");
  const parsed = parseYaml(content) as { packages?: string[] } | null;
  return parsed?.packages ?? [];
}

/**
 * Resolves workspace member directories (relative to the project root) from
 * npm/yarn `workspaces` globs or `pnpm-workspace.yaml` package globs.
 */
async function resolveWorkspaceDirectories(
  projectRoot: string,
  globs: string[],
): Promise<string[]> {
  const includes = globs.filter((glob) => !glob.startsWith("!"));
  const excludes = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => glob.slice(1));

  const packageJsonFiles = await fg(
    includes.map((glob) => `${glob.replace(/\/+$/, "")}/${NODE_PACKAGE_FILE}`),
    {
      cwd: projectRoot,
      ignore: [
        "**/node_modules/**",
        ...excludes.map((glob) => `${glob.replace(/\/+$/, "")}/**`),
      ],
      onlyFiles: true,
      dot: false,
    },
  );

  const directories = packageJsonFiles
    .map((file) => normalizePath(file.slice(0, -NODE_PACKAGE_FILE.length - 1)))
    .filter((dir) => dir !== ".");

  return Array.from(new Set(directories)).sort();
}

function internalDependencyNames(
  manifest: PackageManifest,
  packageNameToModuleId: Map<string, string>,
): string[] {
  const internal = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const dependencyName of Object.keys(manifest[field] ?? {})) {
      if (packageNameToModuleId.has(dependencyName)) {
        internal.add(dependencyName);
      }
    }
  }
  return Array.from(internal);
}

export async function getRawProjectInformation(
  projectRoot: string,
): Promise<RawProjectInformation> {
  const rootPackageJson = join(projectRoot, NODE_PACKAGE_FILE);
  const rootExists = await exists(rootPackageJson);

  if (!rootExists) {
    throw new Error(`Root package.json not found at ${rootPackageJson}`);
  }

  const rootManifest = await readManifest(rootPackageJson);

  const workspaceGlobs = workspaceGlobsFromManifest(rootManifest);
  const pnpmGlobs =
    workspaceGlobs.length > 0
      ? []
      : await workspaceGlobsFromPnpm(projectRoot);

  const workspaceDirectories = await resolveWorkspaceDirectories(
    projectRoot,
    workspaceGlobs.length > 0 ? workspaceGlobs : pnpmGlobs,
  );

  const modules = new Map<string, NodeModule>();
  const manifests = new Map<string, PackageManifest>();

  function toModule(
    manifest: PackageManifest,
    relPath: string,
    packageJsonPath: string,
  ): NodeModule {
    const path = normalizePath(relPath);
    return {
      name: manifest.name ?? (path === "." ? "root" : path.split("/").pop()!),
      path,
      type: path === "." ? "root" : "module",
      affectedModules: [],
      version: manifest.version,
      declaredVersion: manifest.version !== undefined,
      packageJsonPath,
      packageName: manifest.name,
    };
  }

  modules.set(":", toModule(rootManifest, ".", rootPackageJson));
  manifests.set(":", rootManifest);

  for (const directory of workspaceDirectories) {
    const packageJsonPath = join(projectRoot, directory, NODE_PACKAGE_FILE);
    const manifest = await readManifest(packageJsonPath);
    const moduleId = moduleIdFromPath(directory);
    modules.set(moduleId, toModule(manifest, directory, packageJsonPath));
    manifests.set(moduleId, manifest);
  }

  const packageNameToModuleId = new Map<string, string>();
  for (const [moduleId, module] of modules) {
    if (module.packageName) {
      packageNameToModuleId.set(module.packageName, moduleId);
    }
  }

  // dependency edges: dependent module -> internal modules it depends on
  const dependencyEdges = new Map<string, Set<string>>();
  for (const [moduleId, manifest] of manifests) {
    const direct = new Set<string>();
    for (const dependencyName of internalDependencyNames(
      manifest,
      packageNameToModuleId,
    )) {
      const dependencyModuleId = packageNameToModuleId.get(dependencyName)!;
      if (dependencyModuleId !== moduleId) direct.add(dependencyModuleId);
    }
    dependencyEdges.set(moduleId, direct);
  }

  const result: Mutable<NodeProjectInformation> = {};

  for (const [moduleId, module] of modules) {
    const affected = new Set<string>();

    // the root workspace contains every member: a root change cascades to all
    if (moduleId === ":") {
      for (const otherId of modules.keys()) {
        if (otherId !== ":") affected.add(otherId);
      }
    }

    for (const [dependent, dependencies] of dependencyEdges) {
      if (dependencies.has(moduleId)) affected.add(dependent);
    }

    result[moduleId] = {
      ...module,
      affectedModules: Array.from(affected).sort(),
    };
  }

  logger.info("Node project information generated", {
    moduleCount: Object.keys(result).length,
  });

  return result;
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Module, ModuleRegistry } from '@versu/core';
import {
  NodeVersionUpdateStrategy,
  updateDependencySpec,
} from '../src/services/node-version-update-strategy';

function makeRegistry(modules: Module[]): ModuleRegistry {
  const map = new Map(modules.map((module) => [module.id, module]));
  return {
    getModuleIds: () => [...map.keys()],
    getModule: (moduleId: string) => {
      const module = map.get(moduleId);
      if (!module) throw new Error(`Module ${moduleId} not found`);
      return module;
    },
    hasModule: (moduleId: string) => map.has(moduleId),
    getModules: () => map,
  };
}

function makeModule(overrides: Partial<Module> & Record<string, unknown>): Module {
  return {
    id: ':',
    name: 'root',
    path: '.',
    type: 'root',
    affectedModules: new Set<string>(),
    version: { version: '1.0.0' },
    declaredVersion: true,
    ...overrides,
  } as unknown as Module;
}

describe('updateDependencySpec', () => {
  it('should preserve range operators', () => {
    expect(updateDependencySpec('1.2.3', '2.0.0')).toBe('2.0.0');
    expect(updateDependencySpec('^1.2.3', '2.0.0')).toBe('^2.0.0');
    expect(updateDependencySpec('~1.2.3', '2.0.0')).toBe('~2.0.0');
    expect(updateDependencySpec('^1.2.3-rc.1', '2.0.0')).toBe('^2.0.0');
  });

  it('should preserve the workspace protocol', () => {
    expect(updateDependencySpec('workspace:1.2.3', '2.0.0')).toBe('workspace:2.0.0');
    expect(updateDependencySpec('workspace:^1.2.3', '2.0.0')).toBe('workspace:^2.0.0');
    expect(updateDependencySpec('workspace:~1.2.3', '2.0.0')).toBe('workspace:~2.0.0');
  });

  it('should leave specs without a concrete version untouched', () => {
    expect(updateDependencySpec('*', '2.0.0')).toBeUndefined();
    expect(updateDependencySpec('workspace:*', '2.0.0')).toBeUndefined();
    expect(updateDependencySpec('workspace:^', '2.0.0')).toBeUndefined();
    expect(updateDependencySpec('workspace:~', '2.0.0')).toBeUndefined();
    expect(updateDependencySpec('>=1.0.0 <2.0.0', '2.0.0')).toBeUndefined();
    expect(updateDependencySpec('file:../core', '2.0.0')).toBeUndefined();
    expect(updateDependencySpec('link:../core', '2.0.0')).toBeUndefined();
    expect(
      updateDependencySpec('github:acme/core#v1.2.3', '2.0.0'),
    ).toBeUndefined();
  });
});

describe('NodeVersionUpdateStrategy', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'plugin-node-update-test-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeJson(relPath: string, data: unknown): Promise<string> {
    const path = join(projectRoot, relPath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    return path;
  }

  async function readJson(relPath: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(projectRoot, relPath), 'utf-8'));
  }

  it('should update module versions and internal dependency ranges', async () => {
    const rootPath = await writeJson('package.json', {
      name: 'monorepo',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    const corePath = await writeJson('packages/core/package.json', {
      name: '@acme/core',
      version: '2.0.0',
    });
    const cliPath = await writeJson('packages/cli/package.json', {
      name: '@acme/cli',
      version: '3.0.0',
      dependencies: {
        '@acme/core': '^2.0.0',
        'lodash': '^4.17.21',
      },
      devDependencies: {
        '@acme/core': 'workspace:*',
      },
    });

    const registry = makeRegistry([
      makeModule({
        id: ':',
        name: 'monorepo',
        packageName: 'monorepo',
        packageJsonPath: rootPath,
      }),
      makeModule({
        id: ':packages:core',
        name: '@acme/core',
        path: 'packages/core',
        type: 'module',
        packageName: '@acme/core',
        packageJsonPath: corePath,
      }),
      makeModule({
        id: ':packages:cli',
        name: '@acme/cli',
        path: 'packages/cli',
        type: 'module',
        packageName: '@acme/cli',
        packageJsonPath: cliPath,
      }),
    ]);

    const strategy = new NodeVersionUpdateStrategy(projectRoot, registry);
    await strategy.writeVersionUpdates(
      new Map([
        [':packages:core', '2.1.0'],
        [':packages:cli', '3.0.1'],
      ]),
    );

    const root = await readJson('package.json');
    const core = await readJson('packages/core/package.json');
    const cli = await readJson('packages/cli/package.json');

    expect(root.version).toBe('1.0.0');
    expect(core.version).toBe('2.1.0');
    expect(cli.version).toBe('3.0.1');
    expect(cli.dependencies).toEqual({
      '@acme/core': '^2.1.0',
      'lodash': '^4.17.21',
    });
    // workspace:* has no concrete version and stays untouched
    expect(cli.devDependencies).toEqual({ '@acme/core': 'workspace:*' });
  });

  it('should not write a version into a package that declares none', async () => {
    const rootPath = await writeJson('package.json', {
      name: 'monorepo',
      private: true,
    });

    const registry = makeRegistry([
      makeModule({
        id: ':',
        name: 'monorepo',
        declaredVersion: false,
        packageName: 'monorepo',
        packageJsonPath: rootPath,
      }),
    ]);

    const strategy = new NodeVersionUpdateStrategy(projectRoot, registry);
    await strategy.writeVersionUpdates(new Map([[':', '1.1.0']]));

    const root = await readJson('package.json');
    expect(root.version).toBeUndefined();
  });

  it('should preserve indentation and trailing newline', async () => {
    const path = join(projectRoot, 'package.json');
    await writeFile(
      path,
      '{\n    "name": "my-app",\n    "version": "1.0.0"\n}\n',
      'utf-8',
    );

    const registry = makeRegistry([
      makeModule({
        id: ':',
        name: 'my-app',
        packageName: 'my-app',
        packageJsonPath: path,
      }),
    ]);

    const strategy = new NodeVersionUpdateStrategy(projectRoot, registry);
    await strategy.writeVersionUpdates(new Map([[':', '1.0.1']]));

    const content = await readFile(path, 'utf-8');
    expect(content).toBe('{\n    "name": "my-app",\n    "version": "1.0.1"\n}\n');
  });
});

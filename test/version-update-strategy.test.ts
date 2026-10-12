import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import type { Module, ModuleRegistry } from '@versu/core';
import { execa } from 'execa';
import { parse, stringify } from 'yaml';
import {
  NodeVersionUpdateStrategy,
  updateDependencySpec,
} from '../src/services/node-version-update-strategy';
import { NodeModuleSystemFactory } from '../src/services/node-module-system-factory';
import type { LockfileUpdater } from '../src/services/lockfile-updater';

async function createStrategy(projectRoot: string, registry: ModuleRegistry) {
  return new NodeModuleSystemFactory(projectRoot).createVersionUpdateStrategy(registry);
}

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

  it('should invoke all injected updaters after updating manifests', async () => {
    const packageJsonPath = await writeJson('package.json', {
      name: 'app', version: '1.0.0',
    });
    const npm: LockfileUpdater = {
      update: vi.fn(),
    };
    const pnpm: LockfileUpdater = {
      update: vi.fn(async () => {
        expect((await readJson('package.json')).version).toBe('2.0.0');
      }),
    };
    const registry = makeRegistry([makeModule({ packageJsonPath, packageName: 'app' })]);

    await new NodeVersionUpdateStrategy(projectRoot, registry, [npm, pnpm])
      .writeVersionUpdates(new Map([[':', '2.0.0']]));

    expect(npm.update).toHaveBeenCalledExactlyOnceWith(projectRoot);
    expect(pnpm.update).toHaveBeenCalledExactlyOnceWith(projectRoot);
  });

  async function configureYarn(packageName: string): Promise<void> {
    const yarnPath = createRequire(import.meta.url).resolve(`${packageName}/bin/yarn.js`);
    await writeFile(join(projectRoot, '.yarnrc'), `yarn-path ${JSON.stringify(yarnPath)}\n`);
    await writeFile(join(projectRoot, '.yarnrc.yml'), stringify({
      yarnPath, enableTelemetry: false, enableGlobalCache: false,
    }));
  }

  it.each([
    ['yarn-classic', '1'],
    ['yarn-v2', '2'],
    ['yarn-modern', '4'],
  ])('should synchronize %s workspace lockfiles with scripts disabled', async (yarnPackage, major) => {
    await configureYarn(yarnPackage);
    const rootPath = await writeJson('package.json', {
      name: 'monorepo', version: '1.0.0', private: true,
      workspaces: ['packages/*'],
      ...(major === '2' ? {} : { dependencies: { 'local-tool': 'file:./vendor/tool' } }),
      scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'script-ran\', \'\')"' },
    });
    const corePath = await writeJson('packages/core/package.json', {
      name: '@acme/core', version: '1.0.0',
    });
    await writeJson('vendor/tool/package.json', {
      name: 'local-tool', version: '1.0.0',
      scripts: { postinstall: 'node -e "throw new Error(\'Scripts must not run\')"' },
    });
    const cliPath = await writeJson('packages/cli/package.json', {
      name: '@acme/cli', version: '1.0.0',
      dependencies: { '@acme/core': major === '1' ? '^1.0.0' : 'workspace:^1.0.0' },
    });
    const env = {
      YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', YARN_ENABLE_SCRIPTS: 'false',
    };
    await execa('yarn', major === '1'
      ? ['install', '--ignore-scripts', '--non-interactive']
      : major === '2' ? ['install', '--skip-builds'] : ['install', '--mode=update-lockfile'], {
      cwd: projectRoot, env,
    });
    const registry = makeRegistry([
      makeModule({ packageName: 'monorepo', packageJsonPath: rootPath }),
      makeModule({
        id: ':packages:core', path: 'packages/core', type: 'module',
        packageName: '@acme/core', packageJsonPath: corePath,
      }),
      makeModule({
        id: ':packages:cli', path: 'packages/cli', type: 'module',
        packageName: '@acme/cli', packageJsonPath: cliPath,
      }),
    ]);

    await (await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':packages:core', '2.0.0']]));

    expect((await readJson('packages/cli/package.json')).dependencies)
      .toEqual({ '@acme/core': major === '1' ? '^2.0.0' : 'workspace:^2.0.0' });
    const lockfile = await readFile(join(projectRoot, 'yarn.lock'), 'utf8');
    if (major !== '2') expect(lockfile).toContain('local-tool');
    if (major !== '1') {
      expect(lockfile).toContain('@acme/core@workspace:^2.0.0');
      expect(lockfile).not.toContain('@acme/core@workspace:^1.0.0');
    }
    await expect(access(join(projectRoot, 'script-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (major === '4') {
      await expect(access(join(projectRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(projectRoot, '.pnp.cjs'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await execa('yarn', major === '1'
      ? ['install', '--ignore-scripts', '--non-interactive', '--frozen-lockfile']
      : major === '2' ? ['install', '--immutable', '--skip-builds']
      : ['install', '--immutable', '--mode=skip-build'], {
      cwd: projectRoot, env: { YARN_ENABLE_SCRIPTS: 'false', CI: 'true' },
    });
    expect(await readFile(join(projectRoot, 'yarn.lock'), 'utf8')).toBe(lockfile);
  }, 30000);

  it('should propagate Yarn synchronization failures', async () => {
    await configureYarn('yarn-modern');
    const packageJsonPath = await writeJson('package.json', {
      name: 'my-app', version: '1.0.0',
      dependencies: { missing: 'workspace:*' },
    });
    await writeFile(join(projectRoot, 'yarn.lock'), '');
    const registry = makeRegistry([
      makeModule({ packageName: 'my-app', packageJsonPath }),
    ]);

    await expect((await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':', '1.1.0']])))
      .rejects.toThrow('Failed to synchronize yarn lockfile');
  }, 15000);

  it('should synchronize pnpm workspace dependency specifiers and permit a frozen install', async () => {
    const rootPath = await writeJson('package.json', {
      name: 'monorepo', private: true,
    });
    const corePath = await writeJson('packages/core/package.json', {
      name: '@acme/core', version: '1.0.0',
    });
    const cliPath = await writeJson('packages/cli/package.json', {
      name: '@acme/cli', version: '1.0.0',
      dependencies: { '@acme/core': 'workspace:^1.0.0' },
      scripts: {
        preinstall: 'node -e "require(\'fs\').writeFileSync(\'script-ran\', \'\')"',
      },
    });
    await writeFile(join(projectRoot, 'pnpm-workspace.yaml'), stringify({
      packages: ['packages/*'],
    }));
    await writeFile(join(projectRoot, 'pnpm-lock.yaml'), stringify({
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      importers: {
        '.': {},
        'packages/core': {},
        'packages/cli': {
          dependencies: {
            '@acme/core': { specifier: 'workspace:^1.0.0', version: 'link:../core' },
          },
        },
      },
    }));
    const registry = makeRegistry([
      makeModule({ packageName: 'monorepo', packageJsonPath: rootPath, declaredVersion: false }),
      makeModule({
        id: ':packages:core', path: 'packages/core', type: 'module',
        packageName: '@acme/core', packageJsonPath: corePath,
      }),
      makeModule({
        id: ':packages:cli', path: 'packages/cli', type: 'module',
        packageName: '@acme/cli', packageJsonPath: cliPath,
      }),
    ]);

    await (await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':packages:core', '2.0.0']]));

    expect(parse(await readFile(join(projectRoot, 'pnpm-lock.yaml'), 'utf8')))
      .toMatchObject({
        importers: {
          'packages/cli': {
            dependencies: {
              '@acme/core': { specifier: 'workspace:^2.0.0', version: 'link:../core' },
            },
          },
        },
      });
    await expect(access(join(projectRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(projectRoot, 'packages/cli/script-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(projectRoot, 'package-lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await execa('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--frozen-lockfile'], {
      cwd: projectRoot, env: { CI: 'true' },
    });
  }, 15000);

  it('should synchronize a standalone nested pnpm lockfile', async () => {
    const packageJsonPath = await writeJson('packages/core/package.json', {
      name: '@acme/core', version: '1.0.0',
    });
    const directory = join(projectRoot, 'packages/core');
    await writeFile(join(directory, 'pnpm-lock.yaml'), stringify({
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      importers: { '.': {} },
    }));
    const registry = makeRegistry([
      makeModule({
        id: ':packages:core', path: 'packages/core', type: 'module',
        packageName: '@acme/core', packageJsonPath,
      }),
    ]);

    await (await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':packages:core', '2.0.0']]));

    expect((await readJson('packages/core/package.json')).version).toBe('2.0.0');
    expect(parse(await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8')))
      .toMatchObject({ importers: { '.': {} } });
    await expect(access(join(projectRoot, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15000);

  it('should propagate pnpm synchronization failures', async () => {
    const packageJsonPath = await writeJson('package.json', {
      name: 'my-app', version: '1.0.0',
      dependencies: { missing: 'workspace:*' },
    });
    await writeFile(join(projectRoot, 'pnpm-lock.yaml'), stringify({
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      importers: { '.': {} },
    }));
    const registry = makeRegistry([
      makeModule({ packageName: 'my-app', packageJsonPath }),
    ]);

    await expect((await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':', '1.1.0']])))
      .rejects.toThrow('Failed to synchronize pnpm lockfile');
  }, 15000);

  it.each([
    ['package-lock.json', 1],
    ['package-lock.json', 2],
    ['package-lock.json', 3],
    ['npm-shrinkwrap.json', 3],
  ])('should synchronize %s (lockfile version %s) without installing or running scripts', async (filename, lockfileVersion) => {
    const manifest = {
      name: 'my-app',
      version: '1.0.0',
      scripts: {
        preinstall: 'node -e "require(\'fs\').writeFileSync(\'script-ran\', \'\')"',
      },
    };
    const packageJsonPath = await writeJson('package.json', manifest);
    await writeJson(filename, {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion,
      requires: true,
      ...(lockfileVersion === 1 ? {} : { packages: { '': manifest } }),
    });
    const registry = makeRegistry([
      makeModule({ packageName: manifest.name, packageJsonPath }),
    ]);

    await (await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':', '1.1.0']]));

    const lockfile = await readJson(filename);
    expect(lockfile.version).toBe('1.1.0');
    expect(lockfile.packages).toMatchObject({ '': { version: '1.1.0' } });
    await expect(access(join(projectRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(projectRoot, 'script-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (filename === 'npm-shrinkwrap.json') {
      await expect(access(join(projectRoot, 'package-lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 15000);

  it('should synchronize the shared workspace lockfile after all manifest and dependency updates', async () => {
    const root = {
      name: 'monorepo',
      private: true,
      workspaces: ['packages/*'],
      dependencies: { '@acme/core': '^1.0.0' },
    };
    const core = { name: '@acme/core', version: '1.0.0' };
    const cli = {
      name: '@acme/cli',
      version: '1.0.0',
      dependencies: { '@acme/core': '^1.0.0' },
    };
    const rootPath = await writeJson('package.json', root);
    const corePath = await writeJson('packages/core/package.json', core);
    const cliPath = await writeJson('packages/cli/package.json', cli);
    await writeJson('package-lock.json', {
      name: 'monorepo',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': root,
        'packages/core': core,
        'packages/cli': cli,
        'node_modules/@acme/core': { resolved: 'packages/core', link: true },
        'node_modules/@acme/cli': { resolved: 'packages/cli', link: true },
      },
    });
    const registry = makeRegistry([
      makeModule({ packageName: root.name, packageJsonPath: rootPath, declaredVersion: false }),
      makeModule({
        id: ':packages:core', path: 'packages/core', type: 'module',
        packageName: core.name, packageJsonPath: corePath,
      }),
      makeModule({
        id: ':packages:cli', path: 'packages/cli', type: 'module',
        packageName: cli.name, packageJsonPath: cliPath,
      }),
    ]);

    await (await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':packages:core', '2.0.0']]));

    const lockfile = await readJson('package-lock.json');
    expect(lockfile.version).toBeUndefined();
    expect(lockfile.packages).toMatchObject({
      '': { dependencies: { '@acme/core': '^2.0.0' } },
      'packages/core': { version: '2.0.0' },
      'packages/cli': { version: '1.0.0', dependencies: { '@acme/core': '^2.0.0' } },
      'node_modules/@acme/core': { resolved: 'packages/core', link: true },
    });
  }, 15000);

  it('should synchronize a lockfile beside a changed nested package', async () => {
    const packageJsonPath = await writeJson('packages/core/package.json', {
      name: '@acme/core', version: '1.0.0',
    });
    await writeJson('packages/core/package-lock.json', {
      name: '@acme/core', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: '@acme/core', version: '1.0.0' } },
    });
    const registry = makeRegistry([
      makeModule({
        id: ':packages:core', path: 'packages/core', type: 'module',
        packageName: '@acme/core', packageJsonPath,
      }),
    ]);

    await (await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':packages:core', '2.0.0']]));

    expect(await readJson('packages/core/package-lock.json')).toMatchObject({
      version: '2.0.0', packages: { '': { version: '2.0.0' } },
    });
    await expect(access(join(projectRoot, 'package-lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15000);

  it('should not rewrite lockfiles when no manifests change', async () => {
    const packageJsonPath = await writeJson('package.json', {
      name: 'my-app', version: '1.0.0',
    });
    const lockPath = await writeJson('package-lock.json', {
      name: 'my-app', version: '1.0.0', lockfileVersion: 1,
    });
    const before = await readFile(lockPath, 'utf8');
    const registry = makeRegistry([
      makeModule({ packageName: 'my-app', packageJsonPath }),
    ]);
    const strategy = (await createStrategy(projectRoot, registry));

    await strategy.writeVersionUpdates(new Map());
    expect(await readFile(lockPath, 'utf8')).toBe(before);
  });

  it('should propagate npm synchronization failures', async () => {
    const packageJsonPath = await writeJson('package.json', {
      name: 'my-app', version: '1.0.0',
      dependencies: { invalid: 'unsupported:1.0.0' },
    });
    await writeJson('package-lock.json', {
      name: 'my-app', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'my-app', version: '1.0.0' } },
    });
    const registry = makeRegistry([
      makeModule({ packageName: 'my-app', packageJsonPath }),
    ]);

    await expect((await createStrategy(projectRoot, registry))
      .writeVersionUpdates(new Map([[':', '1.1.0']])))
      .rejects.toThrow('Failed to synchronize npm lockfile');
  }, 15000);

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

    const strategy = (await createStrategy(projectRoot, registry));
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

    const strategy = (await createStrategy(projectRoot, registry));
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

    const strategy = (await createStrategy(projectRoot, registry));
    await strategy.writeVersionUpdates(new Map([[':', '1.0.1']]));

    const content = await readFile(path, 'utf-8');
    expect(content).toBe('{\n    "name": "my-app",\n    "version": "1.0.1"\n}\n');
  });
});

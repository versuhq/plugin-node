import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawProjectInformation } from '../src/node-project-information';

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

describe('getRawProjectInformation', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'plugin-node-test-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('should handle a single package project', async () => {
    await writeJson(join(projectRoot, 'package.json'), {
      name: 'my-app',
      version: '1.2.3',
    });

    const result = await getRawProjectInformation(projectRoot);

    expect(Object.keys(result)).toEqual([':']);
    expect(result[':']).toMatchObject({
      name: 'my-app',
      path: '.',
      type: 'root',
      version: '1.2.3',
      declaredVersion: true,
      affectedModules: [],
    });
  });

  it('should throw when root package.json is missing', async () => {
    await expect(getRawProjectInformation(projectRoot)).rejects.toThrow(
      /Root package.json not found/,
    );
  });

  it('should discover npm workspaces and dependency cascade', async () => {
    await writeJson(join(projectRoot, 'package.json'), {
      name: 'monorepo',
      version: '1.0.0',
      workspaces: ['packages/*'],
    });
    await writeJson(join(projectRoot, 'packages/core/package.json'), {
      name: '@acme/core',
      version: '2.0.0',
    });
    await writeJson(join(projectRoot, 'packages/cli/package.json'), {
      name: '@acme/cli',
      version: '3.0.0',
      dependencies: { '@acme/core': '^2.0.0', 'lodash': '^4.17.21' },
    });

    const result = await getRawProjectInformation(projectRoot);

    expect(Object.keys(result).sort()).toEqual([
      ':',
      ':packages:cli',
      ':packages:core',
    ]);

    // root affects all workspace members
    expect(result[':']?.affectedModules).toEqual([
      ':packages:cli',
      ':packages:core',
    ]);

    // cli depends on core -> core affects cli; external deps ignored
    expect(result[':packages:core']?.affectedModules).toEqual([':packages:cli']);
    expect(result[':packages:cli']?.affectedModules).toEqual([]);

    expect(result[':packages:core']).toMatchObject({
      name: '@acme/core',
      path: 'packages/core',
      type: 'module',
      version: '2.0.0',
      declaredVersion: true,
      packageName: '@acme/core',
    });
  });

  it('should support the object form of the workspaces field', async () => {
    await writeJson(join(projectRoot, 'package.json'), {
      name: 'monorepo',
      version: '1.0.0',
      workspaces: { packages: ['libs/*'] },
    });
    await writeJson(join(projectRoot, 'libs/utils/package.json'), {
      name: '@acme/utils',
      version: '0.1.0',
    });

    const result = await getRawProjectInformation(projectRoot);

    expect(Object.keys(result).sort()).toEqual([':', ':libs:utils']);
  });

  it('should discover pnpm workspaces from pnpm-workspace.yaml', async () => {
    await writeJson(join(projectRoot, 'package.json'), {
      name: 'monorepo',
      version: '1.0.0',
    });
    await writeFile(
      join(projectRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
      'utf-8',
    );
    await writeJson(join(projectRoot, 'packages/core/package.json'), {
      name: '@acme/core',
      version: '2.0.0',
    });

    const result = await getRawProjectInformation(projectRoot);

    expect(Object.keys(result).sort()).toEqual([':', ':packages:core']);
    expect(result[':packages:core']?.type).toBe('module');
  });

  it('should honor negated workspace globs and skip node_modules', async () => {
    await writeJson(join(projectRoot, 'package.json'), {
      name: 'monorepo',
      version: '1.0.0',
      workspaces: ['packages/*', '!packages/excluded'],
    });
    await writeJson(join(projectRoot, 'packages/core/package.json'), {
      name: '@acme/core',
      version: '2.0.0',
    });
    await writeJson(join(projectRoot, 'packages/excluded/package.json'), {
      name: '@acme/excluded',
      version: '9.9.9',
    });
    await writeJson(
      join(projectRoot, 'node_modules/some-dep/package.json'),
      { name: 'some-dep', version: '0.0.1' },
    );

    const result = await getRawProjectInformation(projectRoot);

    expect(Object.keys(result).sort()).toEqual([':', ':packages:core']);
  });

  it('should mark modules without a version as not declaring a version', async () => {
    await writeJson(join(projectRoot, 'package.json'), {
      name: 'monorepo',
      workspaces: ['packages/*'],
    });
    await writeJson(join(projectRoot, 'packages/core/package.json'), {
      name: '@acme/core',
      version: '2.0.0',
    });

    const result = await getRawProjectInformation(projectRoot);

    expect(result[':']?.declaredVersion).toBe(false);
    expect(result[':']?.version).toBeUndefined();
    expect(result[':packages:core']?.declaredVersion).toBe(true);
  });
});

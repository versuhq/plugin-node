import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { NodeAdapterIdentifier } from '../src/services/node-adapter-identifier';

describe('NodeAdapterIdentifier', () => {
  let projectRoot: string;
  const identifier = new NodeAdapterIdentifier();

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'plugin-node-identifier-test-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('should expose node adapter metadata', () => {
    expect(identifier.metadata.id).toBe('node');
    expect(identifier.metadata.capabilities.supportsSnapshots).toBe(false);
  });

  it('should accept a project with package.json in the root', async () => {
    await writeFile(join(projectRoot, 'package.json'), '{}', 'utf-8');
    expect(await identifier.accept(projectRoot)).toBe(true);
  });

  it('should reject a project without package.json', async () => {
    expect(await identifier.accept(projectRoot)).toBe(false);
  });

  it('should reject a non-existing project root', async () => {
    expect(await identifier.accept(join(projectRoot, 'missing'))).toBe(false);
  });
});

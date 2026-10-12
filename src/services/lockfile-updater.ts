import { execa } from "execa";

export interface LockfileUpdater {
  update(directory: string): Promise<void>;
}

export async function synchronizeLockfile(
  packageManager: string,
  args: string[],
  directory: string,
  env?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await execa(packageManager, args, {
      cwd: directory,
      env,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Failed to synchronize ${packageManager} lockfile in ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

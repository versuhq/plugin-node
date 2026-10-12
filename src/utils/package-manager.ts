import { execa } from "execa";

export async function runPackageManagerCommand(
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
      `Failed to run ${packageManager} ${args.join(" ")} in ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

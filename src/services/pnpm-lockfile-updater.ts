import { exists } from "@versu/core";
import { join } from "path";
import { PNPM_LOCKFILE } from "../constants.js";
import {
  synchronizeLockfile,
  type LockfileUpdater,
} from "./lockfile-updater.js";

export class PnpmLockfileUpdater implements LockfileUpdater {
  async update(directory: string): Promise<void> {
    if (!(await exists(join(directory, PNPM_LOCKFILE)))) return;

    await synchronizeLockfile(
      "pnpm",
      [
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--no-frozen-lockfile",
      ],
      directory,
    );
  }
}

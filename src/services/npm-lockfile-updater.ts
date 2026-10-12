import { exists } from "@versu/core";
import { join } from "path";
import { NPM_LOCKFILES } from "../constants.js";
import {
  runPackageManagerCommand,
  type LockfileUpdater,
} from "./lockfile-updater.js";

export class NpmLockfileUpdater implements LockfileUpdater {
  async update(directory: string): Promise<void> {
    for (const filename of NPM_LOCKFILES) {
      if (!(await exists(join(directory, filename)))) continue;

      await runPackageManagerCommand(
        "npm",
        [
          "--prefix",
          ".",
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        directory,
      );
      return;
    }
  }
}

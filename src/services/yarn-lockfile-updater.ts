import { exists } from "@versu/core";
import { join } from "path";
import { YARN_LOCKFILE } from "../constants.js";
import {
  runPackageManagerCommand,
  type LockfileUpdater,
} from "./lockfile-updater.js";

export class YarnLockfileUpdater implements LockfileUpdater {
  async update(directory: string): Promise<void> {
    if (!(await exists(join(directory, YARN_LOCKFILE)))) return;

    const version = await runPackageManagerCommand(
      "yarn",
      ["--version"],
      directory,
    );
    const majorVersion = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version)?.[1];
    if (!majorVersion || Number(majorVersion) < 1) {
      throw new Error(`Unsupported Yarn version "${version}" in ${directory}`);
    }

    if (majorVersion === "1") {
      // Classic has no lockfile-only install mode.
      await runPackageManagerCommand(
        "yarn",
        [
          "install",
          "--ignore-scripts",
          "--non-interactive",
          "--production=false",
          "--no-frozen-lockfile",
        ],
        directory,
      );
    } else {
      await runPackageManagerCommand(
        "yarn",
        Number(majorVersion) >= 3
          ? ["install", "--mode=update-lockfile"]
          : ["install", "--skip-builds"],
        directory,
        {
          YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
          YARN_ENABLE_SCRIPTS: "false",
        },
      );
    }
  }
}

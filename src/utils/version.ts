import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

type PackageManifest = {
  name: string;
  version: string;
  author?: string;
  authors?: string[] | string;
};

// package.json ships with the published package, two levels above this
// module (src/utils or dist/utils), so reading it at runtime keeps the
// reported version from drifting from the released one.
const manifest: PackageManifest = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
    "utf-8",
  ),
);

function resolveAuthors(): string[] {
  if (Array.isArray(manifest.authors)) {
    return manifest.authors;
  }
  if (manifest.authors !== undefined) {
    return manifest.authors.split(/[, ]/).filter(Boolean);
  }
  if (manifest.author) {
    return [manifest.author];
  }
  return ["Unknown Author"];
}

export const VERSION = manifest.version;
export const PACKAGE_NAME = manifest.name;
export const AUTHORS = resolveAuthors();

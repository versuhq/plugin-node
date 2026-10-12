<!-- markdownlint-disable MD041 -->

![versu](docs/assets/images/versu-hero.png)

<!-- markdownlint-enable MD041 -->

# @versu/plugin-node - Node.js Adapter Plugin

Node.js adapter plugin for Versu. Provides support for detecting and updating versions in Node.js projects, including npm, yarn and pnpm workspace monorepos.

## Installation

```bash
npm install @versu/core @versu/plugin-node
```

## Usage

Once installed, the plugin is discovered automatically from `node_modules` (or list it explicitly in the `plugins` array of your `versu.config.js`):

```typescript
import { VersuRunner } from "@versu/core";

const runner = new VersuRunner({
  repoRoot: "/path/to/repository",
  adapter: "node", // Optional - auto-detected
  // ...other options as needed
});

const result = await runner.run();
```

## Auto-Detection

The plugin automatically activates when `package.json` is present in the repository root.

## Workspace Support

Workspace members are discovered from:

- the `workspaces` field of the root `package.json` (npm / yarn, array or `{ packages: [] }` form), or
- `pnpm-workspace.yaml` (`packages` globs) when the root `package.json` declares no workspaces.

Projects without workspaces are handled as a single root module.

Dependencies between workspace packages (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`) are used to build the dependency cascade: bumping a package also affects the packages that depend on it.

## Notes

- Module IDs follow Gradle-style notation (e.g., `:` for root, `:packages:core`).
- The plugin updates:
  - the `version` field of a module's `package.json` when the module declares a version.
  - internal dependency ranges pointing at renumbered workspace packages, preserving the range operator and the `workspace:` protocol (e.g. `^1.2.3` → `^2.0.0`, `workspace:~1.2.3` → `workspace:~2.0.0`).
- Specs without a concrete version are left untouched: `*`, `workspace:*`, `workspace:^`, `workspace:~`, `file:`, `link:`, git/url specs and compound ranges.
- After manifest changes, existing npm lockfiles (`package-lock.json` or `npm-shrinkwrap.json`) are synchronized using `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`.
- Existing pnpm lockfiles (`pnpm-lock.yaml`) are synchronized using `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`, including in CI where frozen lockfiles are normally enforced.
- Existing Yarn lockfiles (`yarn.lock`) are synchronized using the project's Yarn executable. Yarn 3+ uses `install --mode=update-lockfile`, with immutable installs and lifecycle scripts disabled. Yarn Classic (v1) and Yarn 2 require a full install because they lack lockfile-only mode; scripts are disabled and lockfile updates are allowed.
- Synchronization includes shared root lockfiles for workspace changes. The corresponding package manager must be available on `PATH`; synchronization failures stop the update rather than leaving a successful release with a stale lockfile. Lockfile synchronization is skipped in directories without an existing lockfile for that package manager.
- Each updater checks for its own lockfile before running. If multiple package-manager lockfile types are present, all of them are synchronized.

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

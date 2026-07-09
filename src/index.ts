import type { PluginContract } from "@versu/core";
import { NodeAdapterIdentifier } from "./services/node-adapter-identifier.js";
import { NodeModuleSystemFactory } from "./services/node-module-system-factory.js";
import { AUTHORS, VERSION } from "./utils/version.js";

const nodePlugin: PluginContract = {
  id: "node",
  name: "Node.js",
  description:
    "Adapter plugin for Node.js projects. Provides support for detecting and updating versions in npm, yarn and pnpm workspace projects.",
  version: VERSION,
  authors: AUTHORS,
  adapters: [
    {
      id: "node",
      adapterIdentifierFactory: async (_configDirectory: string) => {
        return {
          id: "node",
          create: async () => new NodeAdapterIdentifier()
        };
      },
      moduleSystemFactory: async (repoRoot: string, _configDirectory: string) =>
        new NodeModuleSystemFactory(repoRoot),
    },
  ],
};

export default nodePlugin;

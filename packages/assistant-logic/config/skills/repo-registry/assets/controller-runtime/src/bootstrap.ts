import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultControllerRoot,
  getStringArg,
  parseArgs,
  registryRoot,
  writeYaml,
  ensureDir,
  pathExists
} from "./fs-utils.js";
import { RegistryConfigSchema, RegistryIndexSchema, type RegistryConfig, type RegistryIndex } from "./schema.js";

export async function bootstrapController(controllerRoot = defaultControllerRoot()): Promise<{
  controllerRoot: string;
  registryRoot: string;
  indexPath: string;
  configPath: string;
}> {
  const root = registryRoot(controllerRoot);
  const indexPath = path.join(root, "index.yaml");
  const configPath = path.join(root, "config.yaml");

  await ensureDir(path.join(root, "repos"));

  if (!(await pathExists(indexPath))) {
    const initialIndex: RegistryIndex = RegistryIndexSchema.parse({
      version: 1,
      controller_root: controllerRoot,
      repos: {}
    });
    await writeYaml(indexPath, initialIndex);
  }

  if (!(await pathExists(configPath))) {
    const initialConfig: RegistryConfig = RegistryConfigSchema.parse({
      version: 1,
      default_engine: "claude",
      default_codex_model: "gpt-5.5",
      default_codex_effort: "xhigh"
    });
    await writeYaml(configPath, initialConfig);
  }

  return {
    controllerRoot,
    registryRoot: root,
    indexPath,
    configPath
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const controllerRoot = getStringArg(args, "controller-root") || defaultControllerRoot();
  const result = await bootstrapController(controllerRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

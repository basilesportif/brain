import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultControllerRoot,
  getBooleanArg,
  parseArgs,
  readYaml,
  registryRoot,
  requireStringArg,
  sanitizeAlias
} from "./fs-utils.js";
import { RegistryIndexSchema, RepoStateSchema } from "./schema.js";

export async function resolveRepo(alias: string, controllerRoot = defaultControllerRoot()) {
  const cleanAlias = sanitizeAlias(alias);
  const root = registryRoot(controllerRoot);
  const index = await readYaml(path.join(root, "index.yaml"), RegistryIndexSchema);
  const entry = index.repos[cleanAlias];
  if (!entry) {
    throw new Error(`Unknown repo alias '${cleanAlias}'`);
  }

  const statePath = path.join(root, "repos", cleanAlias, "state.yaml");
  const state = await readYaml(statePath, RepoStateSchema);

  return {
    alias: cleanAlias,
    entry,
    state,
    statePath
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const alias = requireStringArg(args, "alias");
  const json = getBooleanArg(args, "json");
  const controllerRoot = typeof args["controller-root"] === "string" ? args["controller-root"] : defaultControllerRoot();
  const resolved = await resolveRepo(alias, controllerRoot);

  if (json) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Alias: ${resolved.alias}`,
      `Repo: ${resolved.entry.path}`,
      `Default branch: ${resolved.entry.default_branch}`,
      `Preferred engine: ${resolved.state.preferred_engine}`,
      `State: ${resolved.statePath}`
    ].join("\n") + "\n"
  );
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

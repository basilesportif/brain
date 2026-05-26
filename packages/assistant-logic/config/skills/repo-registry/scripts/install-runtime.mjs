#!/usr/bin/env node

import { cp, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? 1}`));
    });
  });
}

function requireAbsolutePath(value, envKey) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${envKey} must be an absolute path: ${value}`);
  }
  return value;
}

function resolveControllerRoot({ args, env }) {
  if (typeof args["controller-root"] === "string") {
    return {
      controllerRoot: requireAbsolutePath(args["controller-root"], "--controller-root"),
      source: "arg:controller-root"
    };
  }
  if (env.ASSISTANT_WORKSPACE) {
    return {
      controllerRoot: requireAbsolutePath(env.ASSISTANT_WORKSPACE, "ASSISTANT_WORKSPACE"),
      source: "env:ASSISTANT_WORKSPACE"
    };
  }
  if (env.ASSISTANT_HOME) {
    const containerRoot = requireAbsolutePath(env.ASSISTANT_HOME, "ASSISTANT_HOME");
    return {
      controllerRoot: path.join(containerRoot, "workspace"),
      source: "env:ASSISTANT_HOME/workspace"
    };
  }
  if (env.ASSISTANT_CONTAINER_ROOT) {
    const containerRoot = requireAbsolutePath(env.ASSISTANT_CONTAINER_ROOT, "ASSISTANT_CONTAINER_ROOT");
    return {
      controllerRoot: path.join(containerRoot, "workspace"),
      source: "env:ASSISTANT_CONTAINER_ROOT/workspace"
    };
  }
  if (env.ASSISTANT_CLAUDE_ROOT) {
    const containerRoot = requireAbsolutePath(env.ASSISTANT_CLAUDE_ROOT, "ASSISTANT_CLAUDE_ROOT");
    return {
      controllerRoot: path.join(containerRoot, "workspace"),
      source: "env:ASSISTANT_CLAUDE_ROOT/workspace"
    };
  }
  return {
    controllerRoot: path.join(os.homedir(), ".assistant-claude", "workspace"),
    source: "legacy-default"
  };
}

async function listTopLevel(targetPath) {
  try {
    const entries = await readdir(targetPath);
    return entries.sort();
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const controllerRootResolution = resolveControllerRoot({ args, env: process.env });
  const controllerRoot = controllerRootResolution.controllerRoot;

  const skipInstall = args["skip-install"] === true;
  const skipBuild = args["skip-build"] === true;
  const skipBootstrap = args["skip-bootstrap"] === true;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const skillDir = path.resolve(__dirname, "..");
  const sourceRuntimeDir = path.join(skillDir, "assets", "controller-runtime");
  const registryDir = path.join(controllerRoot, ".claude", "repo-registry");
  const targetRuntimeDir = path.join(registryDir, "runtime");

  const sourceStats = await stat(sourceRuntimeDir).catch(() => null);
  if (!sourceStats || !sourceStats.isDirectory()) {
    throw new Error(`Missing bundled runtime at ${sourceRuntimeDir}`);
  }

  await mkdir(registryDir, { recursive: true });
  // Clear the previous dist so files removed in source (e.g. install-codex-sdk.js)
  // don't linger after upgrades. node_modules is left in place to avoid an
  // unnecessary reinstall.
  await rm(path.join(targetRuntimeDir, "dist"), { recursive: true, force: true });
  await cp(sourceRuntimeDir, targetRuntimeDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== "node_modules" && base !== "dist" && base !== ".DS_Store";
    }
  });

  if (!skipInstall) {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-package-lock"], {
      cwd: targetRuntimeDir,
      env: process.env
    });
  }

  if (!skipBuild) {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: targetRuntimeDir,
      env: process.env
    });
  }

  if (!skipBootstrap) {
    const realTargetRuntimeDir = await realpath(targetRuntimeDir);
    await run(process.execPath, [path.join(realTargetRuntimeDir, "dist", "bootstrap.js"), "--controller-root", controllerRoot], {
      cwd: targetRuntimeDir,
      env: process.env
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        controllerRoot,
        controllerRootSource: controllerRootResolution.source,
        targetRuntimeDir,
        runtimeEntries: await listTopLevel(targetRuntimeDir),
        registryEntries: await listTopLevel(registryDir)
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

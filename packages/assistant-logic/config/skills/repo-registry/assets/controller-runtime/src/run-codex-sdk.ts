import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { defaultControllerRoot, ensureParentDir, parseArgs, requireStringArg } from "./fs-utils.js";
import { resolveRepo } from "./resolve-repo.js";

/**
 * Verify the `codex` CLI binary is available on this machine. Throws with an
 * actionable error if it is not.
 */
export function ensureCodexCliAvailable(): void {
  const result = spawnSync("which", ["codex"], { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      "Codex CLI not found on PATH. Install it (e.g. `npm install -g @openai/codex`) before running Codex handoffs."
    );
  }
}

/**
 * Run a child process and return the exit code. stdio is inherited so output
 * streams through to the parent's terminal (matching the previous SDK behavior).
 */
function spawnAndWait(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: options.env || process.env
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Build the local `codex exec` argument vector. The prompt is supplied via stdin
 * (the `-` positional means "read prompt from stdin"), so callers must redirect
 * the prompt file to stdin when invoking the command.
 *
 * `effort` maps to `-c model_reasoning_effort=<value>` (the config key exposed
 * by the Codex CLI; confirmed from `~/.codex/config.toml` and `codex exec --help`).
 */
function buildLocalCodexArgs(options: {
  model: string;
  effort?: string | null;
  artifactPath: string;
}): string[] {
  const artifactDir = path.dirname(path.resolve(options.artifactPath));
  const args = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    options.model
  ];
  if (options.effort) {
    args.push("-c", `model_reasoning_effort=${options.effort}`);
  }
  args.push("--add-dir", artifactDir, "-o", options.artifactPath, "-");
  return args;
}

/**
 * Run codex against a local repo. The prompt is streamed in via stdin and the
 * artifact is written by codex itself via the `-o` flag.
 */
async function runCodexLocal(options: {
  repoRoot: string;
  promptFile: string;
  artifactPath: string;
  model: string;
  effort?: string | null;
}): Promise<void> {
  await ensureParentDir(options.artifactPath);
  const args = buildLocalCodexArgs({
    model: options.model,
    effort: options.effort,
    artifactPath: options.artifactPath
  });

  // Use a shell so we can redirect stdin from the prompt file. Quoting handles
  // any whitespace in the supplied paths.
  const shellCmd = `codex ${args
    .map((arg) => (/^[A-Za-z0-9._\-/=]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`))
    .join(" ")} < '${options.promptFile.replace(/'/g, "'\\''")}'`;

  const exitCode = await spawnAndWait("bash", ["-c", shellCmd], {
    cwd: options.repoRoot
  });

  if (exitCode !== 0) {
    throw new Error(`codex exec exited with status ${exitCode}`);
  }
}

/**
 * Run codex against a remote repo. We scp the prompt file to the remote host,
 * run `codex exec` there with the artifact written to a remote tmp file, then
 * scp the artifact back and clean up.
 */
async function runCodexRemote(options: {
  host: string;
  remoteRepoPath: string;
  promptFile: string;
  artifactPath: string;
  model: string;
  effort?: string | null;
}): Promise<void> {
  const id = randomUUID();
  const remotePromptPath = `/tmp/codex-prompt-${id}`;
  const remoteArtifactPath = `/tmp/codex-artifact-${id}`;

  await ensureParentDir(options.artifactPath);

  // 1) scp prompt to remote
  let exit = await spawnAndWait("scp", [options.promptFile, `${options.host}:${remotePromptPath}`]);
  if (exit !== 0) {
    throw new Error(`scp prompt to ${options.host} failed with status ${exit}`);
  }

  // 2) ssh exec codex
  // Quote remote path components defensively.
  // effort maps to -c model_reasoning_effort=<value> (confirmed via `codex exec --help` and config.toml).
  const effortFlag = options.effort
    ? ` -c 'model_reasoning_effort=${options.effort.replace(/'/g, "'\\''")}'`
    : "";
  const remoteCmd = [
    `cd '${options.remoteRepoPath.replace(/'/g, "'\\''")}'`,
    `codex exec --dangerously-bypass-approvals-and-sandbox -m '${options.model.replace(/'/g, "'\\''")}' ${effortFlag} -o '${remoteArtifactPath}' - < '${remotePromptPath}'`
  ].join(" && ");

  exit = await spawnAndWait("ssh", [options.host, remoteCmd]);
  if (exit !== 0) {
    // Best-effort cleanup before throwing.
    spawnSync("ssh", [options.host, `rm -f '${remotePromptPath}' '${remoteArtifactPath}'`], { stdio: "ignore" });
    throw new Error(`remote codex exec on ${options.host} failed with status ${exit}`);
  }

  // 3) scp artifact back
  exit = await spawnAndWait("scp", [`${options.host}:${remoteArtifactPath}`, options.artifactPath]);
  if (exit !== 0) {
    spawnSync("ssh", [options.host, `rm -f '${remotePromptPath}' '${remoteArtifactPath}'`], { stdio: "ignore" });
    throw new Error(`scp artifact from ${options.host} failed with status ${exit}`);
  }

  // 4) cleanup remote tmp files
  spawnSync("ssh", [options.host, `rm -f '${remotePromptPath}' '${remoteArtifactPath}'`], { stdio: "ignore" });
}

/**
 * Dispatch a Codex handoff via the `codex` CLI. For local repos this runs
 * directly; for remote repos this scp/ssh's into the dev server. The function
 * name is preserved for backwards compatibility with existing callers.
 */
export async function runCodexSdk(options: {
  alias: string;
  promptFile: string;
  artifactPath: string;
  model: string;
  effort?: string | null;
  controllerRoot?: string;
}): Promise<void> {
  const controllerRoot = options.controllerRoot || defaultControllerRoot();
  const { entry } = await resolveRepo(options.alias, controllerRoot);

  ensureCodexCliAvailable();

  const host = (entry.host || "local").trim();
  if (!host || host === "local") {
    await runCodexLocal({
      repoRoot: entry.path,
      promptFile: options.promptFile,
      artifactPath: options.artifactPath,
      model: options.model,
      effort: options.effort
    });
  } else {
    await runCodexRemote({
      host,
      remoteRepoPath: entry.path,
      promptFile: options.promptFile,
      artifactPath: options.artifactPath,
      model: options.model,
      effort: options.effort
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await runCodexSdk({
    alias: requireStringArg(args, "alias"),
    promptFile: requireStringArg(args, "prompt-file"),
    artifactPath: requireStringArg(args, "artifact"),
    model: requireStringArg(args, "model"),
    effort: typeof args["effort"] === "string" ? args["effort"] : null,
    controllerRoot: typeof args["controller-root"] === "string" ? args["controller-root"] : defaultControllerRoot()
  });
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

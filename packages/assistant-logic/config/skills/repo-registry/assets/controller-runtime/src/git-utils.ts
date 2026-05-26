import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(basePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", basePath, ...args], {
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0"
    }
  });

  return stdout.trim();
}

export async function resolveGitRoot(basePath: string): Promise<string> {
  return runGit(basePath, ["rev-parse", "--show-toplevel"]);
}

export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const output = await runGit(repoRoot, ["branch", "--show-current"]);
    return output || null;
  } catch {
    return null;
  }
}

export async function getDefaultBranch(repoRoot: string): Promise<string> {
  try {
    const ref = await runGit(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    try {
      const localDefault = await runGit(repoRoot, ["config", "--get", "init.defaultBranch"]);
      return localDefault || "main";
    } catch {
      return "main";
    }
  }
}

export async function getRemoteUrl(repoRoot: string): Promise<string | null> {
  try {
    const output = await runGit(repoRoot, ["remote", "get-url", "origin"]);
    return output || null;
  } catch {
    return null;
  }
}

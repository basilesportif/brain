import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

import type { HandoffAction } from "./schema.js";

export type ParsedArgs = {
  _: string[];
  [key: string]: string | boolean | string[];
};

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    if (key in result) {
      const current = result[key];
      if (Array.isArray(current)) {
        current.push(next);
      } else {
        result[key] = [String(current), next];
      }
    } else {
      result[key] = next;
    }
    index += 1;
  }

  return result;
}

export function getStringArg(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
}

export function requireStringArg(args: ParsedArgs, key: string): string {
  const value = getStringArg(args, key);
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

export function getBooleanArg(args: ParsedArgs, key: string): boolean {
  const value = args[key];
  return value === true;
}

export function getStringArgs(args: ParsedArgs, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

export type ControllerRootResolution = {
  controllerRoot: string;
  source: string;
};

function requireAbsolutePath(value: string, envKey: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${envKey} must be an absolute path: ${value}`);
  }
  return value;
}

export function resolveControllerRoot(env: NodeJS.ProcessEnv = process.env): ControllerRootResolution {
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

export function defaultControllerRoot(): string {
  return resolveControllerRoot().controllerRoot;
}

export function registryRoot(controllerRoot = defaultControllerRoot()): string {
  return path.join(controllerRoot, ".claude", "repo-registry");
}

export function repoStateDir(controllerRoot: string, alias: string): string {
  return path.join(registryRoot(controllerRoot), "repos", alias);
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

export async function ensureParentDir(targetPath: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
}

export async function writeText(targetPath: string, contents: string): Promise<void> {
  await ensureParentDir(targetPath);
  await writeFile(targetPath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf8");
}

export async function readText(targetPath: string): Promise<string> {
  return readFile(targetPath, "utf8");
}

export async function readTextIfExists(targetPath: string): Promise<string | null> {
  if (!(await pathExists(targetPath))) {
    return null;
  }
  return readText(targetPath);
}

export async function writeYaml(targetPath: string, value: unknown): Promise<void> {
  await ensureParentDir(targetPath);
  await writeFile(targetPath, stringify(value), "utf8");
}

export async function readYaml<T>(targetPath: string, schema: z.ZodType<T>): Promise<T> {
  const text = await readText(targetPath);
  const parsed = parse(text);
  return schema.parse(parsed);
}

export async function listFilesRecursively(rootPath: string, maxDepth: number, match: (candidate: string) => boolean): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath, depth + 1);
        continue;
      }
      if (match(nextPath)) {
        results.push(nextPath);
      }
    }
  }

  if (await pathExists(rootPath)) {
    await walk(rootPath, 0);
  }

  return results.sort();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";
}

export function artifactName(action: HandoffAction, title: string): string {
  const prefix = action.toUpperCase();
  return `${prefix}_${slugify(title)}.md`;
}

export function promptFileName(action: HandoffAction, title: string): string {
  const prefix = action.toUpperCase();
  return `${prefix}_${slugify(title)}.prompt.md`;
}

export function sanitizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function normalizeLocalReference(value: string): string | null {
  const trimmed = value.trim().replace(/^\.?\//, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return null;
  if (trimmed.startsWith("#")) return null;
  return trimmed.split("#")[0].split("?")[0];
}

export function extractLocalReferences(markdown: string): string[] {
  const results = new Set<string>();
  const markdownLink = /\[[^\]]+\]\(([^)]+)\)/g;
  const backticks = /`([^`\n]+)`/g;

  for (const match of markdown.matchAll(markdownLink)) {
    const normalized = normalizeLocalReference(match[1]);
    if (normalized) results.add(normalized);
  }

  for (const match of markdown.matchAll(backticks)) {
    const normalized = normalizeLocalReference(match[1]);
    if (normalized && (normalized.includes("/") || normalized.endsWith(".md") || normalized.endsWith(".yaml"))) {
      results.add(normalized);
    }
  }

  return [...results];
}

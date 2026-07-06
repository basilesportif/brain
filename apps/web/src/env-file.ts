import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ENV_LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

export function expandHomePath(value: string, home = process.env.HOME ?? ""): string {
  if (value === "~") return home || value;
  if (value.startsWith("~/")) return home ? join(home, value.slice(2)) : value;
  return value;
}

export function resolveEnvFilePath(value: string): string {
  const expanded = expandHomePath(value);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function shellQuoteEnvValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatEnvLine(key: string, value: string): string {
  return `${key}=${shellQuoteEnvValue(value)}`;
}

export function parseEnvKeys(sourceText: string): Set<string> {
  const keys = new Set<string>();
  for (const line of sourceText.split(/\r?\n/)) {
    const match = ENV_LINE_RE.exec(line);
    if (match?.[2]) keys.add(match[2]);
  }
  return keys;
}

export function mergeEnvFileText(sourceText: string, updates: Record<string, string>, managedBy = "Brain control plane"): string {
  const updateKeys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: string[] = [];
  for (const line of lines) {
    const match = ENV_LINE_RE.exec(line);
    const key = match?.[2];
    if (!key || !updateKeys.has(key)) {
      out.push(line);
      continue;
    }
    seen.add(key);
    const value = updates[key] ?? "";
    if (value !== "") out.push(formatEnvLine(key, value));
  }

  const missing = Object.keys(updates).filter((key) => !seen.has(key) && (updates[key] ?? "") !== "");
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1]?.trim() !== "") out.push("");
    out.push(`# Managed by ${managedBy}. Values are write-only in the admin UI.`);
    for (const key of missing) out.push(formatEnvLine(key, updates[key] ?? ""));
  }

  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

export async function atomicWriteFile(filePath: string, content: string, options: { mode?: number; dirMode?: number } = {}): Promise<void> {
  const mode = options.mode ?? 0o600;
  const resolved = resolveEnvFilePath(filePath);
  await mkdir(dirname(resolved), { recursive: true, mode: options.dirMode ?? 0o700 });
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, resolved);
  // writeFile({ mode }) controls newly-created temp files; after rename, chmod
  // once to correct a pre-existing target whose mode was broader.
  await chmod(resolved, mode).catch(() => undefined);
}

/**
 * Fallback-only writer per admin UI redesign plan §6.7. The normal codex-chat
 * config path is IPC `set_config`; this direct env-file merge is retained for
 * bootstrap when codex-chat is not running or has not created its IPC token.
 */
export async function writeMergedEnvFile(filePath: string, updates: Record<string, string>, managedBy?: string): Promise<void> {
  const resolved = resolveEnvFilePath(filePath);
  const current = await readTextIfPresent(resolved);
  const merged = mergeEnvFileText(current, updates, managedBy);
  await atomicWriteFile(resolved, merged);
}

export async function readEnvKeyPresence(filePath: string, keys: readonly string[]): Promise<Record<string, boolean>> {
  const text = await readTextIfPresent(resolveEnvFilePath(filePath));
  const present = parseEnvKeys(text);
  return Object.fromEntries(keys.map((key) => [key, present.has(key)]));
}

export async function envFileMetadata(filePath: string): Promise<{ path: string; present: boolean; mode?: string; size?: number; keysPresent: number }> {
  const resolved = resolveEnvFilePath(filePath);
  const text = await readTextIfPresent(resolved);
  try {
    const info = await stat(resolved);
    return { path: resolved, present: true, mode: `0${(info.mode & 0o777).toString(8)}`, size: info.size, keysPresent: parseEnvKeys(text).size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: resolved, present: false, keysPresent: 0 };
    throw error;
  }
}

async function readTextIfPresent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

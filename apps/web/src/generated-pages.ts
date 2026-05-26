import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:8080/pages";
export const DEFAULT_RUNTIME_ROOT = ".brain/pages";
export const DEFAULT_MANIFEST_PATH = ".brain/web-pages/manifest.json";
export const DEFAULT_TTL_HOURS = 24;
export const DEFAULT_MAX_FILES = 200;
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const allowedExtensions = new Set([".avif", ".css", ".csv", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js", ".json", ".md", ".mjs", ".otf", ".png", ".svg", ".ttf", ".txt", ".webp", ".woff", ".woff2", ".xml"]);
const textExtensions = new Set([".css", ".csv", ".html", ".js", ".json", ".md", ".mjs", ".svg", ".txt", ".xml"]);
const secretBasenames = new Set([".env", ".netrc", ".npmrc", "authorized_keys", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa", "known_hosts"]);
const secretNamePatterns = [/(^|[._-])env([._-]|$)/i, /(^|[._-])(secret|secrets|token|tokens|credential|credentials|passwd|password)([._-]|$)/i, /private[._-]?key/i, /\.(?:db|key|kdbx|p12|pem|pfx|sqlite|sqlite3)$/i];
const secretContentPatterns = [
  { name: "private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "API key assignment", pattern: /\b(?:ANTHROPIC_API_KEY|COMPOSIO_API_KEY|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|AWS_SECRET_ACCESS_KEY)\b\s*[:=]/ },
  { name: "OpenAI-style secret", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

export class GeneratedPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratedPageError";
  }
}

export interface PageFileInfo {
  relativePath: string;
  size: number;
}

export interface PageValidationResult {
  root: string;
  files: PageFileInfo[];
  totalBytes: number;
  title?: string;
}

export interface GeneratedPageManifestEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  ttlHours: number | null;
  visibility: string;
  entrypoint: "index.html";
  url: string;
  runtimePath: string;
  source: Record<string, unknown>;
  status: "scratch" | "promoted" | "expired" | string;
}

export interface GeneratedPageManifest {
  version: 1;
  updatedAt?: string;
  pages: Record<string, GeneratedPageManifestEntry>;
}

export interface PublishPageOptions {
  sourceDir: string;
  id?: string;
  title?: string;
  ttlHours?: number;
  promoted?: boolean;
  visibility?: string;
  status?: string;
  runtimeRoot?: string;
  runtimeHost?: string;
  manifestPath?: string;
  publicBaseUrl?: string;
  source?: Record<string, unknown>;
  replace?: boolean;
  dryRun?: boolean;
  now?: string | Date;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface PublishPageResult {
  id: string;
  title: string;
  url: string;
  runtimePath: string;
  expiresAt: string | null;
  ttlHours: number | null;
  visibility: string;
  status: string;
  files: number;
  totalBytes: number;
  dryRun: boolean;
}

export interface PrunePagesOptions {
  runtimeRoot?: string;
  runtimeHost?: string;
  manifestPath?: string;
  now?: string | Date;
  dryRun?: boolean;
}

export async function validatePageDirectory(sourceDir: string, options: Partial<PublishPageOptions> = {}): Promise<PageValidationResult> {
  const root = path.resolve(sourceDir);
  const rootInfo = await safeLstat(root, `Source directory does not exist: ${sourceDir}`);
  if (!rootInfo.isDirectory()) throw new GeneratedPageError(`Source path is not a directory: ${sourceDir}`);

  const indexInfo = await safeLstat(path.join(root, "index.html"), "Generated pages must include index.html at the package root");
  if (!indexInfo.isFile()) throw new GeneratedPageError("index.html exists but is not a regular file");

  const files: PageFileInfo[] = [];
  await collectFiles(root, "", files, {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  });
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (totalBytes > maxTotalBytes) throw new GeneratedPageError(`Page package is too large: ${totalBytes} bytes exceeds ${maxTotalBytes}`);

  return { root, files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), totalBytes, title: await readTitle(path.join(root, "index.html")) };
}

export async function publishPage(options: PublishPageOptions): Promise<PublishPageResult> {
  const now = normalizeNow(options.now);
  const validation = await validatePageDirectory(options.sourceDir, options);
  const runtimeRoot = stripTrailingSlash(options.runtimeRoot ?? process.env.BRAIN_WEB_RUNTIME_ROOT ?? process.env.CODEX_CHAT_WEB_RUNTIME_ROOT ?? DEFAULT_RUNTIME_ROOT);
  const runtimeHost = options.runtimeHost ?? process.env.BRAIN_WEB_RUNTIME_HOST ?? process.env.CODEX_CHAT_WEB_RUNTIME_HOST;
  const manifestPath = options.manifestPath ?? process.env.BRAIN_WEB_MANIFEST_PATH ?? process.env.CODEX_CHAT_WEB_MANIFEST_PATH ?? DEFAULT_MANIFEST_PATH;
  const publicBaseUrl = stripTrailingSlash(options.publicBaseUrl ?? process.env.BRAIN_WEB_PUBLIC_BASE_URL ?? process.env.CODEX_CHAT_WEB_PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL);
  const manifest = await readManifest(manifestPath);
  const id = await resolvePublishId(options.id, manifest, runtimeRoot, Boolean(options.replace), runtimeHost);
  const title = options.title ?? validation.title ?? id;
  const promoted = Boolean(options.promoted);
  const ttlHours = promoted ? null : normalizeTtlHours(options.ttlHours ?? DEFAULT_TTL_HOURS);
  const createdAt = manifest.pages[id]?.createdAt ?? now.toISOString();
  const updatedAt = now.toISOString();
  const expiresAt = promoted ? null : new Date(now.getTime() + (ttlHours ?? 0) * 60 * 60 * 1000).toISOString();
  const runtimePath = runtimePathFor(runtimeRoot, id);
  const entry: GeneratedPageManifestEntry = {
    id,
    title,
    createdAt,
    updatedAt,
    expiresAt,
    ttlHours,
    visibility: options.visibility ?? "private-link",
    entrypoint: "index.html",
    url: `${publicBaseUrl}/${id}/`,
    runtimePath: `${runtimePath}/`,
    source: options.source ?? {},
    status: promoted ? "promoted" : (options.status ?? "scratch"),
  };

  if (!options.dryRun) {
    await copyToRuntime(validation, runtimeRoot, id, Boolean(options.replace), runtimeHost);
    await writeManifest(manifestPath, { ...manifest, updatedAt, pages: { ...manifest.pages, [id]: entry } });
  }

  return { id, title, url: entry.url, runtimePath: entry.runtimePath, expiresAt, ttlHours, visibility: entry.visibility, status: entry.status, files: validation.files.length, totalBytes: validation.totalBytes, dryRun: Boolean(options.dryRun) };
}

export async function pruneExpiredPages(options: PrunePagesOptions = {}) {
  const now = normalizeNow(options.now);
  const runtimeRoot = stripTrailingSlash(options.runtimeRoot ?? process.env.BRAIN_WEB_RUNTIME_ROOT ?? process.env.CODEX_CHAT_WEB_RUNTIME_ROOT ?? DEFAULT_RUNTIME_ROOT);
  const runtimeHost = options.runtimeHost ?? process.env.BRAIN_WEB_RUNTIME_HOST ?? process.env.CODEX_CHAT_WEB_RUNTIME_HOST;
  const manifestPath = options.manifestPath ?? process.env.BRAIN_WEB_MANIFEST_PATH ?? process.env.CODEX_CHAT_WEB_MANIFEST_PATH ?? DEFAULT_MANIFEST_PATH;
  const manifest = await readManifest(manifestPath);
  const pages = { ...manifest.pages };
  const pruned: Array<{ id: string; runtimePath: string; expiresAt: string }> = [];
  const retained: string[] = [];

  for (const [id, page] of Object.entries(pages)) {
    validatePageId(id);
    if (!page.expiresAt || page.status === "promoted") {
      retained.push(id);
      continue;
    }
    const expiresAt = new Date(page.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw new GeneratedPageError(`Manifest page ${id} has invalid expiresAt`);
    if (expiresAt > now) {
      retained.push(id);
      continue;
    }
    const runtimePath = runtimePathFor(runtimeRoot, id);
    if (!options.dryRun) {
      await removeRuntimePath(runtimePath, runtimeHost);
      pages[id] = { ...page, status: "expired", updatedAt: now.toISOString(), prunedAt: now.toISOString() } as GeneratedPageManifestEntry & { prunedAt: string };
    }
    pruned.push({ id, runtimePath: `${runtimePath}/`, expiresAt: page.expiresAt });
  }

  if (!options.dryRun && pruned.length > 0) await writeManifest(manifestPath, { ...manifest, updatedAt: now.toISOString(), pages });
  return { pruned, retained, checkedAt: now.toISOString(), dryRun: Boolean(options.dryRun) };
}

export async function readManifest(manifestPath: string): Promise<GeneratedPageManifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    return { version: 1, ...parsed, pages: parsed.pages && typeof parsed.pages === "object" ? parsed.pages : {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, pages: {} };
    if (error instanceof SyntaxError) throw new GeneratedPageError(`Manifest is not valid JSON: ${manifestPath}`);
    throw error;
  }
}

export async function writeManifest(manifestPath: string, manifest: GeneratedPageManifest): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o755 });
  const tmp = path.join(path.dirname(manifestPath), `.manifest.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ version: 1, updatedAt: manifest.updatedAt, pages: manifest.pages ?? {} }, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, manifestPath);
}

async function collectFiles(root: string, relativeDir: string, files: PageFileInfo[], limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }): Promise<void> {
  for (const entry of await readdir(path.join(root, relativeDir), { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const relativePath = toPosix(path.join(relativeDir, entry.name));
    if (relativePath.includes("../") || path.isAbsolute(relativePath)) throw new GeneratedPageError(`Invalid page path: ${relativePath}`);
    const fullPath = path.join(root, relativePath);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new GeneratedPageError(`Symlinks are not allowed in generated pages: ${relativePath}`);
    if (entry.isDirectory()) {
      await collectFiles(root, relativePath, files, limits);
      continue;
    }
    if (!entry.isFile()) throw new GeneratedPageError(`Unsupported file type in generated page: ${relativePath}`);
    validateFileName(relativePath);
    if (info.size > limits.maxFileBytes) throw new GeneratedPageError(`File is too large: ${relativePath}`);
    files.push({ relativePath, size: info.size });
    if (files.length > limits.maxFiles) throw new GeneratedPageError(`Page package has too many files: exceeds ${limits.maxFiles}`);
    await scanFileContent(fullPath, relativePath, info.size);
  }
}

function validateFileName(relativePath: string): void {
  for (const part of relativePath.split("/")) {
    if (!part || part === "." || part === ".." || part.startsWith(".")) throw new GeneratedPageError(`Hidden or traversal path segments are not allowed in generated pages: ${relativePath}`);
    if (/\p{C}/u.test(part)) throw new GeneratedPageError(`Control characters are not allowed in generated page paths: ${relativePath}`);
  }
  const base = path.basename(relativePath);
  const ext = path.extname(base).toLowerCase();
  if (!allowedExtensions.has(ext)) throw new GeneratedPageError(`Unsupported file extension in generated page: ${relativePath}`);
  if (secretBasenames.has(base) || secretNamePatterns.some((pattern) => pattern.test(relativePath))) throw new GeneratedPageError(`Secret-like file names are not allowed in generated pages: ${relativePath}`);
}

async function scanFileContent(filePath: string, relativePath: string, size: number): Promise<void> {
  if (!textExtensions.has(path.extname(relativePath).toLowerCase()) || size > 1024 * 1024) return;
  const text = await readFile(filePath, "utf8");
  for (const { name, pattern } of secretContentPatterns) {
    if (pattern.test(text)) throw new GeneratedPageError(`Secret-like content (${name}) is not allowed in generated pages: ${relativePath}`);
  }
}

async function copyToRuntime(validation: PageValidationResult, runtimeRoot: string, id: string, replace: boolean, runtimeHost?: string): Promise<void> {
  if (runtimeHost) {
    await copyToRemoteRuntime(validation, runtimeRoot, id, replace, runtimeHost);
    return;
  }
  const target = path.resolve(runtimeRoot, id);
  const root = path.resolve(runtimeRoot);
  if (!target.startsWith(`${root}${path.sep}`)) throw new GeneratedPageError(`Runtime target escapes runtime root: ${target}`);
  if (!replace && await exists(target)) throw new GeneratedPageError(`Page id already exists at runtime target: ${id}`);
  const tmp = path.resolve(runtimeRoot, `.tmp-${id}-${process.pid}-${Date.now()}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o755 });
  for (const file of validation.files) {
    const dest = path.join(tmp, file.relativePath);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
    await copyFile(path.join(validation.root, file.relativePath), dest);
    await chmod(dest, 0o644);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o755 });
  await rename(tmp, target);
}

async function copyToRemoteRuntime(validation: PageValidationResult, runtimeRoot: string, id: string, replace: boolean, runtimeHost: string): Promise<void> {
  const staging = await makeLocalStaging(validation);
  const target = runtimePathFor(runtimeRoot, id);
  const tmp = `${stripTrailingSlash(runtimeRoot)}/.${id}.${process.pid}.${Date.now()}.tmp`;
  try {
    await runCommand("ssh", [runtimeHost, `mkdir -p ${shQuote(runtimeRoot)} && rm -rf ${shQuote(tmp)} && mkdir -p ${shQuote(tmp)}`]);
    await runCommand("rsync", ["-a", "--delete", `${staging}/`, `${runtimeHost}:${tmp}/`]);
    const replaceCommand = replace
      ? `rm -rf ${shQuote(target)} && mv ${shQuote(tmp)} ${shQuote(target)}`
      : `if [ -e ${shQuote(target)} ]; then echo ${shQuote(`Runtime page already exists: ${target}`)} >&2; exit 42; fi; mv ${shQuote(tmp)} ${shQuote(target)}`;
    await runCommand("ssh", [runtimeHost, `chmod -R a+rX,u+w,go-w ${shQuote(tmp)} && ${replaceCommand}`]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function makeLocalStaging(validation: PageValidationResult): Promise<string> {
  const staging = path.join(tmpdir(), `brain-generated-page-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true, mode: 0o755 });
  for (const file of validation.files) {
    const dest = path.join(staging, file.relativePath);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
    await copyFile(path.join(validation.root, file.relativePath), dest);
    await chmod(dest, 0o644);
  }
  return staging;
}

async function removeRuntimePath(runtimePath: string, runtimeHost?: string): Promise<void> {
  if (runtimeHost) {
    await runCommand("ssh", [runtimeHost, `rm -rf -- ${shQuote(runtimePath)}`]);
    return;
  }
  await rm(runtimePath, { recursive: true, force: true });
}

async function resolvePublishId(requestedId: string | undefined, manifest: GeneratedPageManifest, runtimeRoot: string, replace: boolean, runtimeHost?: string): Promise<string> {
  if (requestedId) {
    validatePageId(requestedId);
    if (!replace && (manifest.pages[requestedId] || await runtimePageExists(runtimeRoot, requestedId, runtimeHost))) throw new GeneratedPageError(`Page id already exists: ${requestedId}`);
    return requestedId;
  }
  for (let i = 0; i < 12; i++) {
    const id = `page-${randomBytes(5).toString("hex")}`;
    if (!manifest.pages[id] && !(await runtimePageExists(runtimeRoot, id, runtimeHost))) return id;
  }
  throw new GeneratedPageError("Could not allocate generated page id");
}

function validatePageId(id: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/.test(id) || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new GeneratedPageError(`Invalid page id: ${id}. Use 3-80 lowercase letters, numbers, and hyphens.`);
  }
}

async function runtimePageExists(runtimeRoot: string, id: string, runtimeHost?: string): Promise<boolean> {
  const runtimePath = runtimePathFor(runtimeRoot, id);
  if (runtimeHost) {
    try {
      await runCommand("ssh", [runtimeHost, `test -e ${shQuote(runtimePath)}`]);
      return true;
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode === 1) return false;
      throw error;
    }
  }
  return exists(runtimePath);
}

function runtimePathFor(runtimeRoot: string, id: string): string {
  validatePageId(id);
  return `${stripTrailingSlash(runtimeRoot)}/${id}`;
}

async function readTitle(indexPath: string): Promise<string | undefined> {
  const text = await readFile(indexPath, "utf8");
  return text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
}

async function safeLstat(target: string, message: string) {
  try { return await lstat(target); } catch { throw new GeneratedPageError(message); }
}
async function exists(target: string): Promise<boolean> { try { await access(target, fsConstants.F_OK); return true; } catch { return false; } }
function normalizeNow(now: string | Date | undefined): Date { const date = now instanceof Date ? now : now ? new Date(now) : new Date(); if (Number.isNaN(date.getTime())) throw new GeneratedPageError(`Invalid date: ${now}`); return date; }
function normalizeTtlHours(value: number): number { if (!Number.isFinite(value) || value <= 0) throw new GeneratedPageError(`Invalid ttlHours: ${value}`); return value; }
function stripTrailingSlash(value: string): string { return value.replace(/\/+$/, ""); }
function toPosix(value: string): string { return value.split(path.sep).join("/"); }

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new GeneratedPageError(`${command} failed with exit ${code}: ${stderr.trim() || stdout.trim()}`);
      (error as GeneratedPageError & { exitCode?: number }).exitCode = code ?? undefined;
      reject(error);
    });
  });
}

function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

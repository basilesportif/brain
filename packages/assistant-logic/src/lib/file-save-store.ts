// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { getWorkspaceContext } from "./workspace.js";

const SCHEMA_VERSION = 1;
const MIME_EXTENSIONS = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

function normalizeNullable(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeTimestamp(value) {
  const text = normalizeNullable(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function safeFilenameSegment(value, fallback = "document") {
  const normalized = normalizeNullable(value) || fallback;
  const withoutSeparators = normalized.replace(/[\\/]+/g, " ");
  const cleaned = withoutSeparators
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function pathExists(candidate) {
  try {
    fs.accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  while (!pathExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function findGitRoot(candidate) {
  let current = nearestExistingAncestor(candidate);
  if (!current) return null;
  const info = fs.statSync(current);
  if (info.isFile()) current = path.dirname(current);
  while (true) {
    if (pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isGitIgnored(gitRoot, targetPath) {
  const relative = path.relative(gitRoot, targetPath) || path.basename(targetPath);
  try {
    execFileSync("git", ["-C", gitRoot, "check-ignore", "-q", "--", relative], {
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if (error && error.status === 1) return false;
    return false;
  }
}

function assertIgnoredIfInsideGit(targetPath, options = {}) {
  if (options.allowGitDestination) return;
  const gitRoot = findGitRoot(targetPath);
  if (!gitRoot) return;
  if (isGitIgnored(gitRoot, targetPath)) return;
  throw new Error(
    `Refusing to save a private document under a non-ignored git worktree path: ${targetPath}. ` +
      `Choose a private directory outside git, add an ignore rule, or set ASSISTANT_PRIVATE_DIR/BRAIN_PRIVATE_DIR.`
  );
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

function resolvePrivateRoot(options = {}) {
  const env = options.env || process.env;
  const explicit = options.privateRoot || env.ASSISTANT_PRIVATE_DIR || env.BRAIN_PRIVATE_DIR;
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error(`Private document directory must be absolute: ${explicit}`);
    }
    return path.resolve(explicit);
  }

  const context = options.context || getWorkspaceContext({
    env,
    workspacePath: options.workspacePath,
    mustExist: options.mustExist,
  });
  return path.join(context.containerRoot, "private");
}

function getDocumentPaths(options = {}) {
  const privateRoot = resolvePrivateRoot(options);
  const documentsRoot = path.join(privateRoot, "documents");
  return {
    privateRoot,
    documentsRoot,
    filesRoot: path.join(documentsRoot, "files"),
    metadataPath: path.join(documentsRoot, "metadata.jsonl"),
  };
}

function generateId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `doc_${timestamp}_${crypto.randomBytes(4).toString("hex")}`;
}

function extensionFrom(input) {
  const filenameCandidates = [input.filename, input.title, input.originalFilename]
    .map(normalizeNullable)
    .filter(Boolean);
  for (const candidate of filenameCandidates) {
    const ext = path.extname(candidate);
    if (ext && ext.length <= 16) return ext.toLowerCase().replace(/[^.a-z0-9]/g, "");
  }
  const mimeExt = MIME_EXTENSIONS[String(input.mimeType || "").toLowerCase()];
  return mimeExt || "";
}

function buildDestinationFilename(id, input) {
  const ext = extensionFrom(input);
  const preferredName = normalizeNullable(input.filename) || normalizeNullable(input.title) || normalizeNullable(input.originalFilename) || "document";
  let base = path.basename(preferredName);
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
    base = base.slice(0, -ext.length);
  }
  base = safeFilenameSegment(base, "document");
  return `${id}-${base}${ext}`;
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function readMetadata(metadataPath) {
  if (!fs.existsSync(metadataPath)) return [];
  const text = fs.readFileSync(metadataPath, "utf8");
  const entries = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      entries.push({
        id: `invalid_line_${index + 1}`,
        invalid: true,
        error: error.message,
        raw: line,
      });
    }
  }
  return entries;
}

function appendMetadata(metadataPath, document) {
  ensurePrivateDir(path.dirname(metadataPath));
  fs.appendFileSync(metadataPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(metadataPath, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

async function saveDocument(input = {}, options = {}) {
  const source = normalizeNullable(input.source || input.sourcePath);
  if (!source) throw new Error("source path is required");
  const sourcePath = path.resolve(source);
  const sourceStat = fs.statSync(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`source path is not a file: ${sourcePath}`);

  const paths = getDocumentPaths({ ...options, privateRoot: input.privateRoot || options.privateRoot, workspacePath: input.workspacePath || options.workspacePath });
  const now = options.now || new Date();
  const id = input.id || generateId(now);
  const originalFilename = normalizeNullable(input.originalFilename) || path.basename(sourcePath);
  const title = normalizeNullable(input.title || input.as);
  const destinationFilename = buildDestinationFilename(id, {
    filename: input.filename,
    title,
    originalFilename,
    mimeType: input.mimeType,
  });
  const year = now.toISOString().slice(0, 4);
  const month = now.toISOString().slice(5, 7);
  const destinationDir = path.join(paths.filesRoot, year, month);
  const savedPath = path.join(destinationDir, destinationFilename);

  assertIgnoredIfInsideGit(savedPath, options);
  assertIgnoredIfInsideGit(paths.metadataPath, options);

  ensurePrivateDir(paths.privateRoot);
  ensurePrivateDir(paths.documentsRoot);
  ensurePrivateDir(paths.filesRoot);
  ensurePrivateDir(destinationDir);

  const tmpPath = `${savedPath}.tmp-${process.pid}`;
  fs.copyFileSync(sourcePath, tmpPath);
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  fs.renameSync(tmpPath, savedPath);

  const savedStat = fs.statSync(savedPath);
  const sha256 = input.sha256 || (await hashFile(savedPath));
  const savedAt = now.toISOString();
  const document = {
    schemaVersion: SCHEMA_VERSION,
    id,
    savedAt,
    receivedAt: normalizeTimestamp(input.receivedAt),
    sourcePath,
    originalFilename,
    mimeType: normalizeNullable(input.mimeType),
    sizeBytes: Number(input.sizeBytes || savedStat.size),
    sha256,
    savedPath,
    privateRoot: paths.privateRoot,
    title,
    note: normalizeNullable(input.note),
    project: normalizeNullable(input.project),
    contact: normalizeNullable(input.contact),
    label: normalizeNullable(input.label),
    retention: normalizeNullable(input.retention),
    source: {
      chat: normalizeNullable(input.sourceChat || input.chat),
      message: normalizeNullable(input.sourceMessage || input.message),
    },
  };

  appendMetadata(paths.metadataPath, document);
  return { ok: true, document, metadataPath: paths.metadataPath };
}

function listDocuments(filters = {}, options = {}) {
  const paths = getDocumentPaths({ ...options, privateRoot: filters.privateRoot || options.privateRoot, workspacePath: filters.workspacePath || options.workspacePath });
  let documents = readMetadata(paths.metadataPath).filter((entry) => !entry.invalid);
  const query = normalizeNullable(filters.query);
  const project = normalizeNullable(filters.project);
  const contact = normalizeNullable(filters.contact);
  const label = normalizeNullable(filters.label);

  if (query) {
    const lower = query.toLowerCase();
    documents = documents.filter((doc) => [
      doc.id,
      doc.title,
      doc.note,
      doc.project,
      doc.contact,
      doc.label,
      doc.originalFilename,
      doc.savedPath,
      doc.sourcePath,
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(lower)));
  }
  if (project) documents = documents.filter((doc) => String(doc.project || "").toLowerCase() === project.toLowerCase());
  if (contact) documents = documents.filter((doc) => String(doc.contact || "").toLowerCase() === contact.toLowerCase());
  if (label) documents = documents.filter((doc) => String(doc.label || "").toLowerCase() === label.toLowerCase());

  documents.sort((left, right) => String(right.savedAt || "").localeCompare(String(left.savedAt || "")));
  const limit = filters.limit ? Number(filters.limit) : 50;
  if (Number.isFinite(limit) && limit > 0) documents = documents.slice(0, limit);

  return {
    ok: true,
    count: documents.length,
    documents,
    metadataPath: paths.metadataPath,
    privateRoot: paths.privateRoot,
  };
}

export {
  SCHEMA_VERSION,
  buildDestinationFilename,
  getDocumentPaths,
  listDocuments,
  readMetadata,
  resolvePrivateRoot,
  safeFilenameSegment,
  saveDocument,

};

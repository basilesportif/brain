// @ts-nocheck
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkspaceContext } from "./workspace.js";

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 2 * 60_000;
const heldLocks = new Map();

function cloneDefaultValue(defaultValue) {
  if (typeof defaultValue === "function") {
    return defaultValue();
  }
  return JSON.parse(JSON.stringify(defaultValue));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function uniqueTempPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}`;
  return path.join(dir, `.${base}.${suffix}.tmp`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = uniqueTempPath(filePath);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; the unique temp name avoids cross-writer clobbering.
    }
  }
}

/**
 * Atomically write arbitrary file content: write to a uniquely named temp
 * file in the same directory, then rename over the destination. The mode of
 * an existing destination file is preserved unless options.mode overrides it.
 */
function writeFileAtomic(filePath, content, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = fs.statSync(filePath).mode & 0o777;
    } catch {
      // Destination does not exist yet; fall back to the default mode.
    }
  }
  const writeOptions = { encoding: options.encoding ?? "utf-8" };
  if (mode !== undefined) writeOptions.mode = mode;
  const tmpPath = uniqueTempPath(filePath);
  try {
    fs.writeFileSync(tmpPath, content, writeOptions);
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; the unique temp name avoids cross-writer clobbering.
    }
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Move a file that failed to parse aside as `<path>.corrupt.<timestamp>` so
 * it is preserved for manual recovery instead of being clobbered by the next
 * save. Returns the preserved path, or null if the rename failed.
 */
function preserveCorruptFile(filePath) {
  const corruptPath = `${filePath}.corrupt.${Date.now()}`;
  try {
    fs.renameSync(filePath, corruptPath);
    return corruptPath;
  } catch {
    return null;
  }
}

function formatMigrationHint(context) {
  return `Move the file into ${path.join(context.workspacePath, "data")}/ manually.`;
}

function lockPathFor(filePath) {
  return `${filePath}.lock`;
}

function isStaleLock(lockPath, staleMs) {
  if (!staleMs) return false;
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function releaseFileLock(lockPath) {
  const held = heldLocks.get(lockPath);
  if (!held) return;
  held.count -= 1;
  if (held.count > 0) return;
  heldLocks.delete(lockPath);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // If another process already cleaned up a stale lock, there is nothing to do.
  }
}

function acquireFileLock(filePath, options = {}) {
  const lockPath = lockPathFor(filePath);
  const existing = heldLocks.get(lockPath);
  if (existing) {
    existing.count += 1;
    return () => releaseFileLock(lockPath);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const start = Date.now();
  let attempts = 0;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), filePath }));
      } finally {
        fs.closeSync(fd);
      }
      heldLocks.set(lockPath, { count: 1 });
      return () => releaseFileLock(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (isStaleLock(lockPath, staleMs)) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // Another waiter may have removed it; fall through to retry.
        }
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out waiting for ${lockPath}`);
      }
      attempts += 1;
      sleepSync(Math.min(250, 25 + attempts * 10));
    }
  }
}

function withFileLock(filePath, fn, options = {}) {
  const release = acquireFileLock(filePath, options);
  try {
    return fn();
  } finally {
    release();
  }
}

function createJsonStore(options) {
  const {
    context = getWorkspaceContext(),
    relativePath,
    legacyRelativePaths = [],
    defaultValue,
    label = relativePath,
    onLoad,
  } = options;

  const filePath = path.join(context.workspacePath, relativePath);
  const legacyPaths = legacyRelativePaths.map((relative) =>
    path.join(context.workspacePath, relative)
  );

  function getLegacyConflicts() {
    if (fs.existsSync(filePath)) return [];
    return legacyPaths.filter((candidate) => fs.existsSync(candidate));
  }

  function assertNoLegacyConflict() {
    const legacyConflicts = getLegacyConflicts();
    if (legacyConflicts.length === 0) return;
    throw new Error(
      `Legacy ${label} path detected at ${legacyConflicts.join(", ")}. ${formatMigrationHint(context)}`
    );
  }

  function load() {
    return withFileLock(filePath, loadUnlocked, options.lock);
  }

  function loadUnlocked() {
    assertNoLegacyConflict();
    if (!fs.existsSync(filePath)) {
      return cloneDefaultValue(defaultValue);
    }
    let parsed;
    try {
      parsed = readJsonFile(filePath);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const preservedPath = preserveCorruptFile(filePath);
      throw new Error(
        `Corrupt JSON in ${label} store at ${filePath} (${error.message}). ` +
          (preservedPath
            ? `The corrupt file was preserved at ${preservedPath}; inspect and restore it manually.`
            : "The corrupt file could not be moved aside; inspect and restore it manually.")
      );
    }
    return typeof onLoad === "function" ? onLoad(parsed) : parsed;
  }

  function save(value) {
    return withFileLock(filePath, () => saveUnlocked(value), options.lock);
  }

  function saveUnlocked(value) {
    assertNoLegacyConflict();
    writeJsonAtomic(filePath, value);
    return value;
  }

  function transaction(mutator) {
    return withFileLock(filePath, () => {
      const value = loadUnlocked();
      let shouldSave = true;
      const controls = {
        skipSave() {
          shouldSave = false;
        },
        markDirty() {
          shouldSave = true;
        },
      };
      const result = mutator(value, controls);
      if (shouldSave) saveUnlocked(value);
      return result;
    }, options.lock);
  }

  return {
    context,
    path: filePath,
    legacyPaths,
    exists() {
      return fs.existsSync(filePath);
    },
    getLegacyConflicts,
    assertNoLegacyConflict,
    load,
    save,
    transaction,
  };
}

export {
  acquireFileLock,
  createJsonStore,
  preserveCorruptFile,
  uniqueTempPath,
  withFileLock,
  writeFileAtomic,
  writeJsonAtomic,
  readJsonFile,

};

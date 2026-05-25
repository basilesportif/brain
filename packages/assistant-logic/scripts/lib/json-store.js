const fs = require("fs");
const path = require("path");
const { getWorkspaceContext } = require("./workspace");

function cloneDefaultValue(defaultValue) {
  if (typeof defaultValue === "function") {
    return defaultValue();
  }
  return JSON.parse(JSON.stringify(defaultValue));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function formatMigrationHint(context) {
  return `Move the file into ${path.join(context.workspacePath, "data")}/ manually.`;
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
    assertNoLegacyConflict();
    if (!fs.existsSync(filePath)) {
      return cloneDefaultValue(defaultValue);
    }
    const parsed = readJsonFile(filePath);
    return typeof onLoad === "function" ? onLoad(parsed) : parsed;
  }

  function save(value) {
    assertNoLegacyConflict();
    writeJsonAtomic(filePath, value);
    return value;
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
  };
}

module.exports = {
  createJsonStore,
  writeJsonAtomic,
  readJsonFile,
};

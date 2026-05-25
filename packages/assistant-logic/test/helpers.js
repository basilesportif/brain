const fs = require("fs");
const os = require("os");
const path = require("path");

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function createFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `assistant-claude-${name}-`));
  const repoRoot = path.join(root, "repo");
  const containerRoot = path.join(root, ".assistant-claude");
  const workspacePath = path.join(containerRoot, "workspace");

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "data"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "tasks"), { recursive: true });

  return {
    root,
    repoRoot,
    containerRoot,
    workspacePath,
    writeFile,
  };
}

module.exports = {
  createFixture,
  writeFile,
};

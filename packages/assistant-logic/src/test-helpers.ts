import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function writeFixtureFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

export function createFixture(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `brain-assistant-logic-${name}-`));
  const repoRoot = path.join(root, "repo");
  const containerRoot = path.join(root, ".assistant-claude");
  const workspacePath = path.join(containerRoot, "workspace");

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "data"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "tasks"), { recursive: true });

  return { root, repoRoot, containerRoot, workspacePath, writeFile: writeFixtureFile };
}

export function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

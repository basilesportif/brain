const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const {
  getDocumentPaths,
  listDocuments,
  saveDocument,
} = require("../scripts/lib/file-save-store");

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "file-save-store-"));
}

function rmtemp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("saves a document copy and records lightweight metadata", async () => {
  const root = mktemp();
  try {
    const privateRoot = path.join(root, "private");
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    const sourcePath = path.join(uploads, "Prospectus.PDF");
    fs.writeFileSync(sourcePath, "pdf bytes");

    const result = await saveDocument(
      {
        source: sourcePath,
        project: "Decisive Outcomes",
        contact: "Bill Pate",
        title: "conference prospectus",
        note: "Saved from chat",
        retention: "keep until project closes",
        receivedAt: "2026-05-22T12:34:56Z",
        sourceChat: "253768951",
        sourceMessage: "456",
        mimeType: "application/pdf",
      },
      { privateRoot, now: new Date("2026-05-22T13:00:00Z") }
    );

    assert.equal(result.ok, true);
    assert.equal(result.document.originalFilename, "Prospectus.PDF");
    assert.equal(result.document.receivedAt, "2026-05-22T12:34:56.000Z");
    assert.equal(result.document.sourcePath, sourcePath);
    assert.equal(result.document.project, "Decisive Outcomes");
    assert.equal(result.document.contact, "Bill Pate");
    assert.equal(result.document.source.chat, "253768951");
    assert.equal(result.document.source.message, "456");
    assert.match(result.document.savedPath, /conference prospectus\.pdf$/);
    assert.notEqual(result.document.savedPath, sourcePath);
    assert.equal(fs.readFileSync(result.document.savedPath, "utf8"), "pdf bytes");
    assert.equal(fs.existsSync(sourcePath), true);

    const listed = listDocuments({ project: "Decisive Outcomes" }, { privateRoot });
    assert.equal(listed.count, 1);
    assert.equal(listed.documents[0].id, result.document.id);
    assert.equal(listed.documents[0].savedPath, result.document.savedPath);
  } finally {
    rmtemp(root);
  }
});

test("defaults private storage next to the workspace path", () => {
  const root = mktemp();
  try {
    const workspacePath = path.join(root, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const paths = getDocumentPaths({ workspacePath });
    assert.equal(paths.privateRoot, path.join(root, "private"));
    assert.equal(paths.metadataPath, path.join(root, "private", "documents", "metadata.jsonl"));
  } finally {
    rmtemp(root);
  }
});

test("refuses private document destinations in non-ignored git worktrees", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not available");
    return;
  }

  const root = mktemp();
  try {
    const repo = path.join(root, "repo");
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(uploads, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const sourcePath = path.join(uploads, "file.pdf");
    fs.writeFileSync(sourcePath, "pdf bytes");

    await assert.rejects(
      () => saveDocument({ source: sourcePath }, { privateRoot: path.join(repo, "private") }),
      /Refusing to save a private document under a non-ignored git worktree path/
    );
  } finally {
    rmtemp(root);
  }
});

test("allows ignored private directories inside a git worktree", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not available");
    return;
  }

  const root = mktemp();
  try {
    const repo = path.join(root, "repo");
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(uploads, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, ".gitignore"), "private/*\n!private/README.md\n");
    const sourcePath = path.join(uploads, "file.pdf");
    fs.writeFileSync(sourcePath, "pdf bytes");

    const result = await saveDocument({ source: sourcePath }, { privateRoot: path.join(repo, "private") });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.document.savedPath), true);
  } finally {
    rmtemp(root);
  }
});

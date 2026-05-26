import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { getDocumentPaths, listDocuments, saveDocument } from "./lib/file-save-store.js";

function mktemp() { return fs.mkdtempSync(path.join(os.tmpdir(), "brain-file-save-store-")); }
function rmtemp(dir: string) { fs.rmSync(dir, { recursive: true, force: true }); }

test("saves a document copy and records assistant-agent-logic-compatible metadata", async () => {
  const root = mktemp();
  try {
    const privateRoot = path.join(root, "private");
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    const sourcePath = path.join(uploads, "Prospectus.PDF");
    fs.writeFileSync(sourcePath, "pdf bytes");

    const result = await saveDocument({ source: sourcePath, project: "Decisive Outcomes", contact: "Bill Pate", title: "conference prospectus", note: "Saved from chat", retention: "keep until project closes", receivedAt: "2026-05-22T12:34:56Z", sourceChat: "253768951", sourceMessage: "456", mimeType: "application/pdf" }, { privateRoot, now: new Date("2026-05-22T13:00:00Z") });

    assert.equal(result.ok, true);
    assert.match(result.document.id, /^doc_20260522T130000Z_[0-9a-f]{8}$/);
    assert.equal(result.document.schemaVersion, 1);
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
    assert.equal(listed.metadataPath, path.join(privateRoot, "documents", "metadata.jsonl"));
  } finally { rmtemp(root); }
});

test("defaults private storage next to the workspace path", () => {
  const root = mktemp();
  try {
    const workspacePath = path.join(root, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const paths = getDocumentPaths({ workspacePath });
    assert.equal(paths.privateRoot, path.join(root, "private"));
    assert.equal(paths.metadataPath, path.join(root, "private", "documents", "metadata.jsonl"));
  } finally { rmtemp(root); }
});

test("private document git safety remains compatible", async (t) => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { t.skip("git is not available"); return; }
  const root = mktemp();
  try {
    const repo = path.join(root, "repo");
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(uploads, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const sourcePath = path.join(uploads, "file.pdf");
    fs.writeFileSync(sourcePath, "pdf bytes");
    await assert.rejects(() => saveDocument({ source: sourcePath }, { privateRoot: path.join(repo, "private") }), /Refusing to save a private document under a non-ignored git worktree path/);
    fs.writeFileSync(path.join(repo, ".gitignore"), "private/*\n!private/README.md\n");
    const result = await saveDocument({ source: sourcePath }, { privateRoot: path.join(repo, "private") });
    assert.equal(result.ok, true);
  } finally { rmtemp(root); }
});

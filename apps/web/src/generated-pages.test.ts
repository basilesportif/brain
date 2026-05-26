import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneExpiredPages, publishPage, validatePageDirectory } from "./generated-pages.js";

async function tempRoot() { return mkdtemp(path.join(tmpdir(), "brain-web-")); }
async function writeFileRecursive(filePath: string, content: string) { await mkdir(path.dirname(filePath), { recursive: true }); await writeFile(filePath, content); }
async function makePage(root: string, files: Record<string, string> = {}) {
  const sourceDir = path.join(root, "page");
  await writeFileRecursive(path.join(sourceDir, "index.html"), files["index.html"] ?? "<!doctype html><title>Brain Page</title><main>Hello</main>");
  for (const [relativePath, content] of Object.entries(files)) if (relativePath !== "index.html") await writeFileRecursive(path.join(sourceDir, relativePath), content);
  return sourceDir;
}

test("publishes a static page and updates manifest", async () => {
  const root = await tempRoot();
  try {
    const sourceDir = await makePage(root, { "assets/app.js": "document.body.dataset.ready = 'true';" });
    const result = await publishPage({ sourceDir, id: "demo-page", runtimeRoot: path.join(root, "runtime"), manifestPath: path.join(root, "manifest.json"), publicBaseUrl: "https://example.test/pages", now: "2026-05-21T00:00:00.000Z", source: { agent: "test" } });
    assert.equal(result.url, "https://example.test/pages/demo-page/");
    assert.equal(result.expiresAt, "2026-05-22T00:00:00.000Z");
    assert.equal(await readFile(path.join(root, "runtime", "demo-page", "index.html"), "utf8"), "<!doctype html><title>Brain Page</title><main>Hello</main>");
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.pages["demo-page"].title, "Brain Page");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects secret-like files/content and symlinks", async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(() => makePage(root, { "api-token.txt": "x" }).then((dir) => validatePageDirectory(dir)), /Secret-like file names/);
    const secretPage = path.join(root, "secret-page");
    await writeFileRecursive(path.join(secretPage, "index.html"), "<title>x</title><script>const OPENAI_API_KEY = 'placeholder';</script>");
    await assert.rejects(() => validatePageDirectory(secretPage), /Secret-like content/);
    const slackPage = path.join(root, "slack-page");
    await writeFileRecursive(path.join(slackPage, "index.html"), "<title>x</title><script>const t = 'xoxb-123456789012345678901';</script>");
    await assert.rejects(() => validatePageDirectory(slackPage), /Slack token/);
    const linkedPage = await makePage(path.join(root, "linked"));
    await symlink("/etc/passwd", path.join(linkedPage, "reference.txt"));
    await assert.rejects(() => validatePageDirectory(linkedPage), /Symlinks are not allowed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("honors codex-chat-web compatible environment aliases", async () => {
  const root = await tempRoot();
  const originalBase = process.env.CODEX_CHAT_WEB_PUBLIC_BASE_URL;
  const originalRuntime = process.env.CODEX_CHAT_WEB_RUNTIME_ROOT;
  const originalManifest = process.env.CODEX_CHAT_WEB_MANIFEST_PATH;
  try {
    process.env.CODEX_CHAT_WEB_PUBLIC_BASE_URL = "https://me.galebach.com/pages";
    process.env.CODEX_CHAT_WEB_RUNTIME_ROOT = path.join(root, "runtime");
    process.env.CODEX_CHAT_WEB_MANIFEST_PATH = path.join(root, "manifest.json");
    const sourceDir = await makePage(root);
    const result = await publishPage({ sourceDir, id: "env-page", now: "2026-05-21T00:00:00.000Z" });
    assert.equal(result.url, "https://me.galebach.com/pages/env-page/");
    assert.equal(await readFile(path.join(root, "runtime", "env-page", "index.html"), "utf8"), "<!doctype html><title>Brain Page</title><main>Hello</main>");
  } finally {
    if (originalBase === undefined) delete process.env.CODEX_CHAT_WEB_PUBLIC_BASE_URL; else process.env.CODEX_CHAT_WEB_PUBLIC_BASE_URL = originalBase;
    if (originalRuntime === undefined) delete process.env.CODEX_CHAT_WEB_RUNTIME_ROOT; else process.env.CODEX_CHAT_WEB_RUNTIME_ROOT = originalRuntime;
    if (originalManifest === undefined) delete process.env.CODEX_CHAT_WEB_MANIFEST_PATH; else process.env.CODEX_CHAT_WEB_MANIFEST_PATH = originalManifest;
    await rm(root, { recursive: true, force: true });
  }
});

test("prunes expired scratch pages", async () => {
  const root = await tempRoot();
  try {
    const sourceDir = await makePage(root);
    const runtimeRoot = path.join(root, "runtime");
    const manifestPath = path.join(root, "manifest.json");
    await publishPage({ sourceDir, id: "old-page", runtimeRoot, manifestPath, ttlHours: 1, now: "2026-05-21T00:00:00.000Z" });
    const result = await pruneExpiredPages({ runtimeRoot, manifestPath, now: "2026-05-21T02:00:00.000Z" });
    assert.deepEqual(result.pruned.map((page) => page.id), ["old-page"]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.pages["old-page"].status, "expired");
  } finally { await rm(root, { recursive: true, force: true }); }
});

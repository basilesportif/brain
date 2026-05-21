import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAssistantPack } from "./index.js";

test("validates a portable assistant pack manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-pack-"));
  try {
    await mkdir(path.join(root, "skills", "hello"), { recursive: true });
    await writeFile(path.join(root, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: test\n---\n# Hello\n");
    await writeFile(path.join(root, "assistant-pack.json"), JSON.stringify({
      schemaVersion: 1,
      id: "core",
      name: "Core",
      skills: ["skills/hello/SKILL.md"],
    }));
    const result = await validateAssistantPack(root);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects personal maintainer references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-pack-"));
  try {
    await mkdir(path.join(root, "skills", "web"), { recursive: true });
    await writeFile(path.join(root, "skills", "web", "SKILL.md"), "---\nname: web\ndescription: test\n---\nUse me.galebach.com\n");
    await writeFile(path.join(root, "assistant-pack.json"), JSON.stringify({
      schemaVersion: 1,
      id: "core",
      name: "Core",
      skills: ["skills/web/SKILL.md"],
    }));
    const result = await validateAssistantPack(root);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join("\n"), /personal/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

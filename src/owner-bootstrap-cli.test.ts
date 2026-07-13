import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const brainctl = new URL("./brainctl.js", import.meta.url);

test("brainctl owner bootstrap resolves owner email from setup context and prints the pairing note", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brainctl-owner-bootstrap-"));
  try {
    const storePath = path.join(root, "workspace", "control-plane", "capabilities.json");
    const contextPath = path.join(root, "private", "setup-context.json");
    await mkdir(path.dirname(contextPath), { recursive: true });
    await writeFile(contextPath, `${JSON.stringify({
      version: 1,
      target: "local",
      workspace: "personal",
      workspaceRoot: path.join(root, "workspace"),
      ownerAdminEmail: "owner@example.test",
      secretValuesStored: false,
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      brainctl.pathname,
      "owner",
      "bootstrap",
      "--telegram-user-id", "900000777",
      "--display-name", "Synthetic Owner",
      "--telegram-chat-id", "900000778",
      "--store", storePath,
      "--repo", root,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      details: { storePath: string; changed: boolean; telegramUserId: string; pairingNote: string };
    };
    assert.equal(output.ok, true);
    assert.equal(output.details.storePath, storePath);
    assert.equal(output.details.changed, true);
    assert.equal(output.details.telegramUserId, "900000777");
    assert.match(output.details.pairingNote, /codex-chat's \/pair allowlist.*900000777/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

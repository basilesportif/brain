import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeCodeProvider } from "./index.js";

test("Claude Code provider creates runtime-core compatible sessions", async () => {
  const provider = createClaudeCodeProvider({ transport: "stub" });
  const session = await provider.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, true);
  assert.equal(health.provider, "claude-code");
});

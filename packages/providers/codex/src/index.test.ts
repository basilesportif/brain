import test from "node:test";
import assert from "node:assert/strict";
import { createCodexProvider } from "./index.js";

test("Codex provider creates runtime-core compatible sessions", async () => {
  const provider = createCodexProvider({ transport: "stub" });
  const session = await provider.createSession({ workspaceId: "personal" });
  await session.start();
  const health = await session.health();
  assert.equal(health.ok, true);
  assert.equal(health.provider, "codex");
});

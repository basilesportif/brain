import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkspaceConfig } from "./index.js";

const base = {
  runtime: { activeEntrypointMode: "single-primary" },
  workspaces: {
    personal: {
      workspacePath: "/srv/brain/workspaces/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: {
        "telegram-main": { kind: "telegram", enabled: true },
        "web-preview": { kind: "web", enabled: false },
      },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
  },
};

test("validates single-primary workspace config", () => {
  const result = validateWorkspaceConfig(base);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.config?.workspaces.personal.primaryEntrypointId, "telegram-main");
});

test("rejects multiple enabled entrypoints in single-primary mode", () => {
  const input = structuredClone(base);
  input.workspaces.personal.enabledEntrypoints["web-preview"].enabled = true;
  const result = validateWorkspaceConfig(input);
  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.message).join("\n"), /exactly one enabled entrypoint/);
});

test("rejects prompt secret exposure", () => {
  const input = structuredClone(base);
  input.workspaces.personal.promptContext.exposeChannelSecrets = true;
  const result = validateWorkspaceConfig(input);
  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.path).join("\n"), /exposeChannelSecrets/);
});

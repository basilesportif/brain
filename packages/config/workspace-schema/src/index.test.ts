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

test("accepts private workspace backup, web publishing, and optional Composio surfaces", () => {
  const input = structuredClone(base);
  Object.assign(input.workspaces.personal, {
    backup: {
      strategy: "private-git",
      privateGit: {
        repoPath: "/srv/brain/workspaces/personal/backups/git",
        remote: "git@github.com:example/private-brain-backup.git",
        branch: "main",
      },
    },
    webPublishing: {
      enabled: true,
      mode: "domain",
      domain: "me.example.test",
      baseUrl: "https://me.example.test/pages",
      publishRoot: "/srv/brain/pages",
      reverseProxy: { kind: "caddy" },
    },
    integrations: {
      composio: {
        enabled: true,
        apiKeyRef: "env:COMPOSIO_API_KEY",
        connectedAccountRef: "file:/srv/brain/workspaces/personal/config/composio-account.json",
        dataSources: {
          googleCalendar: {
            enabled: true,
            connectedAccountRef: "file:/srv/brain/workspaces/personal/config/google-calendar-account.json",
            requiredEnvRefs: ["env:COMPOSIO_API_KEY"],
          },
          chat: { enabled: false },
        },
      },
    },
  });
  const result = validateWorkspaceConfig(input);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.config?.workspaces.personal.backup?.privateGit?.branch, "main");
  assert.ok(result.config?.workspaces.personal.backup?.privateGit?.exclude.includes("secrets/**"));
});

test("requires backup destinations and web base URL when optional surfaces are enabled", () => {
  const input = structuredClone(base);
  Object.assign(input.workspaces.personal, {
    backup: { strategy: "private-git", privateGit: { branch: "main" } },
    webPublishing: { enabled: true, mode: "domain", domain: "me.example.test" },
  });
  const result = validateWorkspaceConfig(input);
  assert.equal(result.ok, false);
  const messages = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
  assert.match(messages, /backup\.privateGit\.repoPath/);
  assert.match(messages, /webPublishing\.baseUrl/);
});


test("accepts OpenAI transcription config and defaults attachment scope", () => {
  const input = structuredClone(base);
  Object.assign(input.workspaces.personal, {
    transcription: {
      enabled: true,
      provider: "openai",
      apiKeyRef: "env:OPENAI_API_KEY",
      model: "gpt-4o-mini-transcribe",
      scope: { entrypointIds: ["telegram-main"], attachmentKinds: ["voice", "audio"] },
    },
  });
  const result = validateWorkspaceConfig(input);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.config?.workspaces.personal.transcription?.provider, "openai");
  assert.deepEqual(result.config?.workspaces.personal.transcription?.scope.attachmentKinds, ["voice", "audio"]);
});

test("requires OpenAI transcription key ref and valid entrypoint scope when enabled", () => {
  const input = structuredClone(base);
  Object.assign(input.workspaces.personal, {
    transcription: {
      enabled: true,
      provider: "openai",
      scope: { entrypointIds: ["missing-entrypoint"], attachmentKinds: ["voice"] },
    },
  });
  const result = validateWorkspaceConfig(input);
  assert.equal(result.ok, false);
  const messages = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
  assert.match(messages, /transcription\.apiKeyRef/);
  assert.match(messages, /missing-entrypoint/);
});

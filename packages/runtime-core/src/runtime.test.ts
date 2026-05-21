import test from "node:test";
import assert from "node:assert/strict";
import { BrainRuntime, EchoProviderAdapter } from "./index.js";

test("BrainRuntime turns provider final text into origin-routed outbound action", async () => {
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new EchoProviderAdapter(),
  });
  const result = await runtime.handleInboundEvent({
    id: "evt_1",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "hello",
    receivedAt: "2026-05-21T00:00:00.000Z",
  });
  assert.equal(result.actions[0]?.type, "send_text");
  assert.equal(result.actions[0]?.target?.entrypointId, "telegram-main");
  assert.match(result.cleanText, /Echo: hello/);
});

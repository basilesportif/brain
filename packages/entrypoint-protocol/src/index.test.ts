import test from "node:test";
import assert from "node:assert/strict";
import { routeOutboundToOrigin, type EntryPointInboundEvent } from "./index.js";

test("routeOutboundToOrigin preserves generic origin routing metadata", () => {
  const event: EntryPointInboundEvent = {
    id: "evt_1",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "hello",
    conversation: { id: "chat_1", threadId: "topic_2", metadata: { messageId: "42" } },
    receivedAt: "2026-05-21T00:00:00.000Z",
  };

  const action = routeOutboundToOrigin(event, { type: "send_text", text: "hi" });
  assert.equal(action.workspaceId, "personal");
  assert.equal(action.originatingEventId, "evt_1");
  assert.deepEqual(action.target, {
    route: "originating-entrypoint",
    entrypointId: "telegram-main",
    conversationId: "chat_1",
    threadId: "topic_2",
    replyToExternalMessageId: "42",
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { FakeEntrypointAdapter, routeOutboundToOrigin, type EntryPointInboundEvent } from "./index.js";

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

test("FakeEntrypointAdapter queues inbound events and records outbound dispatches", async () => {
  const entrypoint = new FakeEntrypointAdapter({
    workspaceId: "personal",
    entrypointId: "fake-main",
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });
  entrypoint.enqueueText("hello", { conversationId: "fake-conversation" });
  entrypoint.close();

  const events: EntryPointInboundEvent[] = [];
  for await (const event of entrypoint.inboundEvents()) events.push(event);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.workspaceId, "personal");
  assert.equal(events[0]?.entrypoint.entrypointId, "fake-main");
  assert.equal(events[0]?.conversation?.id, "fake-conversation");

  const result = await entrypoint.dispatch({ type: "send_text", text: "hi" });
  assert.equal(result.status, "queued");
  assert.equal(entrypoint.dispatchedActions[0]?.type, "send_text");
});

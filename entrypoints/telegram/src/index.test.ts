import test from "node:test";
import assert from "node:assert/strict";
import { outboundActionToTelegramIntent, telegramUpdateToInboundEvent } from "./index.js";

test("maps Telegram message-like updates into Brain inbound events", () => {
  const event = telegramUpdateToInboundEvent({
    update_id: 100,
    message: { message_id: 42, date: 1779321600, text: "/doctor now", chat: { id: 123, type: "private" }, from: { id: 7, username: "user" } },
  }, { workspaceId: "personal" });
  assert.equal(event?.kind, "command");
  assert.equal(event?.entrypoint.entrypointId, "telegram-main");
  assert.equal(event?.command, "doctor");
  assert.deepEqual(event?.args, ["now"]);
  assert.equal(event?.conversation?.id, "123");
});

test("maps Brain send_text actions into Telegram call intents", () => {
  const intent = outboundActionToTelegramIntent({
    type: "send_text",
    text: "hello",
    target: { conversationId: "123", threadId: "4", replyToExternalMessageId: "42" },
  });
  assert.equal(intent?.method, "sendMessage");
  assert.equal(intent?.payload.chat_id, "123");
  assert.equal(intent?.payload.message_thread_id, 4);
});

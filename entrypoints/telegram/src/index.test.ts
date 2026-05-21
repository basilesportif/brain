import test from "node:test";
import assert from "node:assert/strict";
import { TelegramEntrypointAdapter, outboundActionToTelegramIntent, telegramUpdateToInboundEvent, type TelegramCallIntent } from "./index.js";

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

test("maps Telegram markdownv2 and terminal status conservatively", () => {
  const markdown = outboundActionToTelegramIntent({
    type: "send_text",
    text: "*hello*",
    format: "markdownv2",
    target: { conversationId: "123" },
  });
  assert.equal(markdown?.payload.parse_mode, "MarkdownV2");
  assert.equal(outboundActionToTelegramIntent({ type: "show_status", status: "done", target: { conversationId: "123" } }), undefined);
});


test("TelegramEntrypointAdapter exposes no-network inbound and outbound protocol mapping", async () => {
  const intents: TelegramCallIntent[] = [];
  const adapter = new TelegramEntrypointAdapter({
    workspaceId: "personal",
    updates: [
      { update_id: 101, message: { message_id: 43, date: 1779321600, text: "hello", chat: { id: 123, type: "private" }, from: { id: 7, username: "user" } } },
    ],
    dispatchIntent: (intent, action) => {
      intents.push(intent);
      return { action, status: "sent", externalMessageId: "sent-1" };
    },
  });

  await adapter.start();
  const events = [];
  for await (const event of adapter.inboundEvents()) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.entrypoint.channelKind, "telegram");
  assert.equal(events[0]?.text, "hello");
  assert.equal((await adapter.health()).lastEventId, "telegram_message_101_43");

  const result = await adapter.dispatch({ type: "send_text", text: "hi", target: { conversationId: "123" } });
  assert.equal(result.status, "sent");
  assert.equal(intents[0]?.method, "sendMessage");
});

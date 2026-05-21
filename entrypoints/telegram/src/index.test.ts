import test from "node:test";
import assert from "node:assert/strict";
import { TelegramBotApiClient, TelegramEntrypointAdapter, handleTelegramWebhookUpdate, outboundActionToTelegramIntent, pollTelegramUpdates, resolveTelegramAttachmentDownload, telegramUpdateToInboundEvent, type TelegramBotApi, type TelegramCallIntent } from "./index.js";

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

test("Telegram admin allowlist filters unauthorized updates", () => {
  const blocked = telegramUpdateToInboundEvent({
    update_id: 102,
    message: { message_id: 44, date: 1779321600, text: "hello", chat: { id: 123, type: "private" }, from: { id: 8, username: "intruder" } },
  }, { workspaceId: "personal", adminAllowlist: { userIds: [7], chatIds: [123] } });
  assert.equal(blocked, undefined);

  const allowed = telegramUpdateToInboundEvent({
    update_id: 103,
    message: { message_id: 45, date: 1779321600, text: "hello", chat: { id: 123, type: "private" }, from: { id: 7, username: "admin" } },
  }, { workspaceId: "personal", adminAllowlist: { userIds: [7], chatIds: [123] } });
  assert.equal(allowed?.actor?.id, "7");
});

test("Telegram polling skeleton maps getUpdates without a real token", async () => {
  const calls: string[] = [];
  const api: TelegramBotApi = {
    async call(method, payload) {
      calls.push(`${method}:${String(payload?.offset ?? "none")}`);
      return {
        ok: true,
        result: [
          { update_id: 200, message: { message_id: 50, date: 1779321600, text: "poll", chat: { id: 123 }, from: { id: 7 } } },
        ],
      };
    },
  };

  const updates = [];
  for await (const update of pollTelegramUpdates(api, { maxPolls: 1 })) updates.push(update);
  assert.equal(updates.length, 1);
  assert.deepEqual(calls, ["getUpdates:none"]);
});

test("Telegram API dispatch and file download boundaries are injectable", async () => {
  const api: TelegramBotApi = {
    async call(method, payload) {
      if (method === "sendMessage") return { ok: true, result: { message_id: 99, payload } };
      if (method === "getFile") return { ok: true, result: { file_id: payload?.file_id, file_unique_id: "uniq", file_size: 123, file_path: "docs/file.txt" } };
      throw new Error(`unexpected method ${method}`);
    },
    async downloadFile(filePath) {
      return { uri: `mock://telegram/${filePath}`, filePath };
    },
  };
  const adapter = new TelegramEntrypointAdapter({ workspaceId: "personal", apiClient: api });
  const sent = await adapter.dispatch({ type: "send_text", text: "hi", target: { conversationId: "123" } });
  assert.equal(sent.status, "sent");
  assert.equal(sent.externalMessageId, "99");

  const attachment = await resolveTelegramAttachmentDownload({ kind: "document", uri: "file_1", metadata: { telegramFileId: "file_1" } }, api);
  assert.equal(attachment.uri, "mock://telegram/docs/file.txt");
  assert.equal(attachment.sizeBytes, 123);
});

test("Telegram webhook skeleton validates secret token", () => {
  assert.throws(() => handleTelegramWebhookUpdate({
    update_id: 300,
    message: { message_id: 60, date: 1779321600, text: "hook", chat: { id: 123 }, from: { id: 7 } },
  }, { workspaceId: "personal", expectedSecretToken: "secret" }, "wrong"), /secret token/);

  const event = handleTelegramWebhookUpdate({
    update_id: 301,
    message: { message_id: 61, date: 1779321600, text: "hook", chat: { id: 123 }, from: { id: 7 } },
  }, { workspaceId: "personal", expectedSecretToken: "secret" }, "secret");
  assert.equal(event?.text, "hook");
});

test("TelegramBotApiClient reports missing token without exposing secrets", async () => {
  const client = new TelegramBotApiClient({});
  await assert.rejects(client.call("getMe"), /token is not configured/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileTelegramPairingStore, FileTelegramPollingStateStore, TelegramBotApiClient, TelegramEntrypointAdapter, createTelegramWebhookServer, handleTelegramWebhookUpdate, loadTelegramToken, outboundActionToTelegramIntent, pollTelegramUpdates, resolveTelegramAttachmentDownload, telegramUpdateToInboundEvent, type TelegramBotApi, type TelegramCallIntent } from "./index.js";

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



test("Telegram pairing bootstrap stores one-time paired identities before allowlist filtering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-pairing-"));
  try {
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const api: TelegramBotApi = {
      async call(method, payload) {
        calls.push({ method, payload });
        return { ok: true, result: { message_id: 100 } };
      },
    };
    const store = new FileTelegramPairingStore(root);
    const adapter = new TelegramEntrypointAdapter({
      workspaceId: "personal",
      adminAllowlist: { denyWhenEmpty: true },
      apiClient: api,
      pairing: { enabled: true, store, codeFactory: () => "123456" },
      updates: [
        { update_id: 700, message: { message_id: 1, text: "hello before pair", chat: { id: 123 }, from: { id: 7 } } },
        { update_id: 701, message: { message_id: 2, text: "/pair 123456", chat: { id: 123 }, from: { id: 7 } } },
        { update_id: 702, message: { message_id: 3, text: "hello after pair", chat: { id: 123 }, from: { id: 7 } } },
      ],
    });
    await adapter.start();
    assert.equal((await adapter.pairingStatus()).codePresent, true);

    const events = [];
    for await (const event of adapter.inboundEvents()) events.push(event);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.text, "hello after pair");
    assert.equal((await store.readPairingCode()), undefined);
    assert.deepEqual((await store.listUsers()).map((user) => user.userId), ["7"]);
    assert.deepEqual((await store.listChats()).map((chat) => chat.chatId), ["123"]);
    assert.equal(calls[0]?.method, "sendMessage");
    assert.match(String(calls[0]?.payload?.text), /Paired user 7/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("Telegram durable polling state stores offsets without replaying updates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-state-"));
  try {
    const store = new FileTelegramPollingStateStore(path.join(root, "telegram-offset.json"));
    const offsets: Array<number | undefined> = [];
    const api: TelegramBotApi = {
      async call(_method, payload) {
        offsets.push(payload?.offset as number | undefined);
        return {
          ok: true,
          result: [
            { update_id: 500, message: { message_id: 70, date: 1779321600, text: "one", chat: { id: 123 }, from: { id: 7 } } },
            { update_id: 501, message: { message_id: 71, date: 1779321600, text: "two", chat: { id: 123 }, from: { id: 7 } } },
          ],
        };
      },
    };
    const updates = [];
    for await (const update of pollTelegramUpdates(api, { maxPolls: 1, stateStore: store })) updates.push(update);
    assert.equal(updates.length, 2);
    assert.deepEqual(offsets, [undefined]);
    assert.equal(await store.getOffset(), 502);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("Telegram adapter can download attachments and append injected audio transcripts", async () => {
  const api: TelegramBotApi = {
    async call(method, payload) {
      if (method === "getFile") return { ok: true, result: { file_id: payload?.file_id, file_path: "voice/audio.ogg", file_size: 12 } };
      throw new Error(`unexpected method ${method}`);
    },
    async downloadFile(filePath) {
      return { localPath: `/tmp/${path.basename(filePath)}`, filePath };
    },
  };
  const adapter = new TelegramEntrypointAdapter({
    workspaceId: "personal",
    apiClient: api,
    attachmentHandling: {
      download: true,
      transcriber: {
        async transcribe(input) {
          assert.equal(input.path, "/tmp/audio.ogg");
          return { text: "transcribed voice note" };
        },
      },
    },
    updates: [
      { update_id: 800, message: { message_id: 1, chat: { id: 123 }, from: { id: 7 }, voice: { file_id: "voice_file", mime_type: "audio/ogg" } } },
    ],
  });
  await adapter.start();
  const events = [];
  for await (const event of adapter.inboundEvents()) events.push(event);
  assert.equal(events.length, 1);
  assert.match(events[0]?.text ?? "", /transcribed voice note/);
  assert.equal(events[0]?.attachments?.[0]?.localPath, "/tmp/audio.ogg");
  assert.equal(events[0]?.attachments?.[0]?.metadata?.transcript, "transcribed voice note");
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

test("Telegram webhook server accepts valid POSTs and rejects wrong secrets", async () => {
  const accepted: string[] = [];
  const server = createTelegramWebhookServer({
    workspaceId: "personal",
    expectedSecretToken: "secret",
    onEvent: (event) => {
      if (event.text) accepted.push(event.text);
    },
  });
  const address = await server.start();
  try {
    const url = `http://${address.host}:${address.port}${address.path}`;
    const bad = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
      body: JSON.stringify({ update_id: 610, message: { message_id: 80, text: "bad", chat: { id: 123 }, from: { id: 7 } } }),
    });
    assert.equal(bad.status, 401);
    const good = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "secret" },
      body: JSON.stringify({ update_id: 611, message: { message_id: 81, text: "good", chat: { id: 123 }, from: { id: 7 } } }),
    });
    assert.equal(good.status, 200);
    assert.deepEqual(accepted, ["good"]);
  } finally {
    await server.stop();
  }
});

test("TelegramBotApiClient reports missing token without exposing secrets", async () => {
  const client = new TelegramBotApiClient({});
  await assert.rejects(client.call("getMe"), /token is not configured/);
});

test("Telegram token loading and local upload boundaries redact secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-token-"));
  const tokenFile = path.join(root, "token");
  const uploadPath = path.join(root, "image.jpg");
  try {
    await writeFile(tokenFile, "123456:secret-token\n");
    await writeFile(uploadPath, "fake-image");
    const loaded = await loadTelegramToken({ tokenFile, required: true });
    assert.equal(loaded.present, true);
    assert.equal(loaded.token, "123456:secret-token");
    assert.equal(loaded.redacted, "present:19chars");

    const calls: Array<{ url: string; bodyType: string }> = [];
    const client = new TelegramBotApiClient({
      tokenRef: { tokenFile },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), bodyType: init?.body instanceof FormData ? "form" : typeof init?.body });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.call("sendPhoto", { chat_id: "123", photo: uploadPath, caption: "hi" });
    assert.equal(calls[0]?.bodyType, "form");
    assert.match(calls[0]?.url ?? "", /bot123456:secret-token\/sendPhoto$/);

    const intent = outboundActionToTelegramIntent({ type: "send_artifact", path: "/tmp/voice.ogg", mimeType: "audio/ogg", target: { conversationId: "123" } });
    assert.equal(intent?.method, "sendVoice");
    assert.equal(intent?.payload.voice, "/tmp/voice.ogg");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

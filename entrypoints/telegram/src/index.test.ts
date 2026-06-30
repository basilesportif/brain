import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileTelegramPairingStore, FileTelegramPollingStateStore, OpenAITelegramAttachmentTranscriber, TelegramBotApiClient, TelegramEntrypointAdapter, createTelegramWebhookServer, handleTelegramWebhookUpdate, loadTelegramToken, outboundActionToTelegramIntent, pollTelegramUpdates, resolveTelegramAttachmentDownload, telegramUpdateToInboundEvent, type OpenAIAudioTranscriptionClient, type TelegramBotApi, type TelegramCallIntent } from "./index.js";

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
  const plainMarkdown = outboundActionToTelegramIntent({
    type: "send_text",
    text: "main_loop: model=gpt-5.5 effort=medium",
    format: "markdown",
    target: { conversationId: "123" },
  });
  assert.equal(plainMarkdown?.payload.parse_mode, undefined);

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

test("Telegram adapter sends an immediate receipt reaction before attachment preparation", async () => {
  const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
  const api: TelegramBotApi = {
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === "setMessageReaction") return { ok: true, result: true };
      if (method === "getFile") return { ok: true, result: { file_id: payload?.file_id, file_path: "docs/file.txt", file_size: 4 } };
      throw new Error(`unexpected method ${method}`);
    },
    async downloadFile(filePath) {
      return { localPath: `/tmp/${path.basename(filePath)}`, filePath, bytes: new TextEncoder().encode("data") };
    },
  };
  const adapter = new TelegramEntrypointAdapter({
    workspaceId: "personal",
    apiClient: api,
    attachmentHandling: { download: true },
    updates: [
      { update_id: 104, message: { message_id: 46, text: "see attached", chat: { id: 123 }, from: { id: 7 }, document: { file_id: "doc_file", file_unique_id: "doc_unique" } } },
    ],
  });

  await adapter.start();
  const events = [];
  for await (const event of adapter.inboundEvents()) events.push(event);

  assert.equal(events.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ["setMessageReaction", "getFile"]);
  assert.deepEqual(calls[0]?.payload, {
    chat_id: "123",
    message_id: 46,
    reaction: [{ type: "emoji", emoji: "👀" }],
  });
});

test("Telegram adapter does not duplicate an immediate receipt reaction through later react dispatch", async () => {
  const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
  const api: TelegramBotApi = {
    async call(method, payload) {
      calls.push({ method, payload });
      return { ok: true, result: true };
    },
  };
  const adapter = new TelegramEntrypointAdapter({
    workspaceId: "personal",
    apiClient: api,
    updates: [
      { update_id: 105, message: { message_id: 47, text: "hello", chat: { id: 123 }, from: { id: 7 } } },
    ],
  });

  await adapter.start();
  const events = [];
  for await (const event of adapter.inboundEvents()) events.push(event);
  assert.equal(events.length, 1);

  const duplicate = await adapter.dispatch({ type: "react", emoji: "👀", target: { conversationId: "123", replyToExternalMessageId: "47" } });
  assert.equal(duplicate.status, "skipped");
  assert.deepEqual(calls.map((call) => call.method), ["setMessageReaction"]);
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
    assert.deepEqual((await store.listIdentities()).map((identity) => [identity.userId, identity.chatId]), [["7", "123"]]);
    assert.deepEqual((await store.listUsers()).map((user) => user.userId), ["7"]);
    assert.deepEqual((await store.listChats()).map((chat) => chat.chatId), ["123"]);
    assert.equal(calls[0]?.method, "sendMessage");
    assert.match(String(calls[0]?.payload?.text), /Paired user 7/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Telegram first-user bootstrap pairs up to two distinct admin user/chat pairs by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-first-user-"));
  try {
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const api: TelegramBotApi = {
      async call(method, payload) {
        calls.push({ method, payload });
        return { ok: true, result: { message_id: 101 } };
      },
    };
    const store = new FileTelegramPairingStore(root);
    const adapter = new TelegramEntrypointAdapter({
      workspaceId: "personal",
      apiClient: api,
      pairing: { enabled: true, store },
      updates: [
        { update_id: 710, message: { message_id: 1, text: "first hello", chat: { id: 123 }, from: { id: 7 } } },
        { update_id: 711, message: { message_id: 2, text: "same chat intruder", chat: { id: 123 }, from: { id: 8 } } },
        { update_id: 712, message: { message_id: 3, text: "same user other chat", chat: { id: 999 }, from: { id: 7 } } },
        { update_id: 713, message: { message_id: 4, text: "second hello", chat: { id: 456 }, from: { id: 8 } } },
        { update_id: 714, message: { message_id: 5, text: "third blocked", chat: { id: 789 }, from: { id: 9 } } },
        { update_id: 715, message: { message_id: 6, text: "paired admin again", chat: { id: 123 }, from: { id: 7 } } },
        { update_id: 716, message: { message_id: 7, text: "second admin again", chat: { id: 456 }, from: { id: 8 } } },
      ],
    });
    await adapter.start();
    assert.deepEqual(await adapter.pairingStatus(), { enabled: true, pending: true, users: 0, chats: 0, adminPairs: 0, maxAdminPairs: 2, codePresent: false });

    const events = [];
    for await (const event of adapter.inboundEvents()) events.push(event);

    assert.deepEqual(events.map((event) => event.text), ["first hello", "second hello", "paired admin again", "second admin again"]);
    assert.deepEqual((await store.listIdentities()).map((identity) => [identity.userId, identity.chatId, identity.isAdmin]), [["7", "123", true], ["8", "456", true]]);
    assert.deepEqual((await store.listUsers()).map((user) => [user.userId, user.isAdmin]), [["7", true], ["8", true]]);
    assert.deepEqual((await store.listChats()).map((chat) => chat.chatId), ["123", "456"]);
    assert.equal((await store.readPairingCode()), undefined);
    assert.deepEqual(await adapter.pairingStatus(), { enabled: true, pending: false, users: 2, chats: 2, adminPairs: 2, maxAdminPairs: 2, codePresent: false });
    const pairReplies = calls.filter((call) => call.method === "sendMessage").map((call) => String(call.payload?.text));
    assert.equal(pairReplies.length, 2);
    assert.match(pairReplies[0] ?? "", /Paired this Telegram user and chat as a Brain admin \(1\/2\)/);
    assert.match(pairReplies[1] ?? "", /Paired this Telegram user and chat as a Brain admin \(2\/2\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram first-user bootstrap can be capped at one admin pair for single-admin deployments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-one-admin-"));
  try {
    const store = new FileTelegramPairingStore(root);
    const adapter = new TelegramEntrypointAdapter({
      workspaceId: "personal",
      pairing: { enabled: true, store, maxAdminPairs: 1 },
      updates: [
        { update_id: 720, message: { message_id: 1, text: "first hello", chat: { id: 123 }, from: { id: 7 } } },
        { update_id: 721, message: { message_id: 2, text: "second blocked", chat: { id: 456 }, from: { id: 8 } } },
        { update_id: 722, message: { message_id: 3, text: "paired admin again", chat: { id: 123 }, from: { id: 7 } } },
      ],
    });
    await adapter.start();

    const events = [];
    for await (const event of adapter.inboundEvents()) events.push(event);

    assert.deepEqual(events.map((event) => event.text), ["first hello", "paired admin again"]);
    assert.deepEqual((await store.listIdentities()).map((identity) => [identity.userId, identity.chatId]), [["7", "123"]]);
    assert.deepEqual(await adapter.pairingStatus(), { enabled: true, pending: false, users: 1, chats: 1, adminPairs: 1, maxAdminPairs: 1, codePresent: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram pairing state reads legacy user/chat files and writes exact admin pairs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-legacy-pairing-"));
  try {
    await writeFile(path.join(root, "telegram_users.json"), `${JSON.stringify([{ userId: "7", isAdmin: true, pairedAt: "2026-01-01T00:00:00.000Z" }])}\n`);
    await writeFile(path.join(root, "telegram_chats.json"), `${JSON.stringify([{ chatId: "123", pairedAt: "2026-01-01T00:00:00.000Z" }])}\n`);
    const store = new FileTelegramPairingStore(root);
    assert.deepEqual(await store.listIdentities(), [{ userId: "7", chatId: "123", isAdmin: true, pairedAt: "2026-01-01T00:00:00.000Z" }]);

    await store.addIdentity("8", "456", true);
    assert.deepEqual((await store.listIdentities()).map((identity) => [identity.userId, identity.chatId]), [["7", "123"], ["8", "456"]]);
    const rawAdmins = JSON.parse(await readFile(path.join(root, "telegram_admins.json"), "utf8")) as { version: number; admins: Array<{ userId: string; chatId: string }> };
    assert.equal(rawAdmins.version, 1);
    assert.deepEqual(rawAdmins.admins.map((identity) => [identity.userId, identity.chatId]), [["7", "123"], ["8", "456"]]);
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
    downloadMaxBytes: 20,
    async call(method, payload) {
      if (method === "getFile") return { ok: true, result: { file_id: payload?.file_id, file_unique_id: "unique_voice", file_path: "voice/audio.ogg", file_size: 12 } };
      throw new Error(`unexpected method ${method}`);
    },
    async downloadFile(filePath) {
      return { localPath: `/tmp/${path.basename(filePath)}`, filePath, bytes: new TextEncoder().encode("ogg-opus") };
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
      { update_id: 800, message: { message_id: 1, caption: "please transcribe", chat: { id: 123 }, from: { id: 7 }, voice: { file_id: "voice_file", file_unique_id: "voice_unique", mime_type: "audio/ogg" } } },
    ],
  });
  await adapter.start();
  const events = [];
  for await (const event of adapter.inboundEvents()) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.text, "please transcribe\nVoice transcript:\ntranscribed voice note\nAudio path: /tmp/audio.ogg");
  assert.equal(events[0]?.attachments?.[0]?.localPath, "/tmp/audio.ogg");
  assert.equal(events[0]?.attachments?.[0]?.metadata?.telegramFileUniqueId, "unique_voice");
  assert.equal(events[0]?.attachments?.[0]?.metadata?.transcript, "transcribed voice note");
});

test("Telegram adapter labels audio transcripts like codex-chat and does not transcribe video unless scoped", async () => {
  const api: TelegramBotApi = {
    async call(method, payload) {
      if (method === "getFile") {
        const id = String(payload?.file_id);
        return { ok: true, result: { file_id: id, file_path: id === "audio_file" ? "audio/song.mp3" : "video/clip.mp4", file_size: 4 } };
      }
      throw new Error(`unexpected method ${method}`);
    },
    async downloadFile(filePath) {
      return { localPath: `/tmp/${path.basename(filePath)}`, filePath, bytes: new TextEncoder().encode("data") };
    },
  };
  const transcribed: string[] = [];
  const adapter = new TelegramEntrypointAdapter({
    workspaceId: "personal",
    apiClient: api,
    attachmentHandling: {
      download: true,
      transcriber: {
        async transcribe(input) {
          transcribed.push(String(input.attachment.kind));
          return { text: `transcribed ${input.attachment.kind}` };
        },
      },
    },
    updates: [
      { update_id: 801, message: { message_id: 1, caption: "ignored by audio parity", chat: { id: 123 }, from: { id: 7 }, audio: { file_id: "audio_file", file_unique_id: "audio_unique", file_name: "song.mp3", mime_type: "audio/mpeg" } } },
      { update_id: 802, message: { message_id: 2, chat: { id: 123 }, from: { id: 7 }, video: { file_id: "video_file", file_unique_id: "video_unique", file_name: "clip.mp4", mime_type: "video/mp4" } } },
    ],
  });
  await adapter.start();
  const events = [];
  for await (const event of adapter.inboundEvents()) events.push(event);
  assert.equal(events[0]?.text, "Audio transcript:\ntranscribed audio\nAudio path: /tmp/song.mp3");
  assert.equal(events[1]?.text, "");
  assert.deepEqual(transcribed, ["audio"]);
});


test("Telegram adapter matches codex-chat disabled transcription parity for voice and audio", async () => {
  const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
  const api: TelegramBotApi = {
    async call(method, payload) {
      calls.push({ method, payload });
      return { ok: true, result: { message_id: 99 } };
    },
  };
  const adapter = new TelegramEntrypointAdapter({
    workspaceId: "personal",
    apiClient: api,
    attachmentHandling: {
      transcribeKinds: ["voice", "audio"],
      transcriptionFailureMode: "codex-chat",
    },
    updates: [
      { update_id: 803, message: { message_id: 3, chat: { id: 123 }, from: { id: 7 }, voice: { file_id: "voice_file", file_unique_id: "voice_unique", mime_type: "audio/ogg" } } },
      { update_id: 804, message: { message_id: 4, chat: { id: 123 }, from: { id: 7 }, audio: { file_id: "audio_file", file_unique_id: "audio_unique", file_name: "song.mp3", mime_type: "audio/mpeg" } } },
    ],
  });
  await adapter.start();
  const events = [];
  for await (const event of adapter.inboundEvents()) events.push(event);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.attachments?.[0]?.kind, "audio");
  assert.equal(events[0]?.text, "");
  assert.deepEqual(calls.map((call) => call.method), ["setMessageReaction", "sendMessage", "setMessageReaction"]);
  assert.deepEqual(calls[1]?.payload, {
    chat_id: "123",
    text: "Voice transcription is not enabled.",
    reply_to_message_id: 3,
  });
});

test("Telegram adapter drops voice events when OpenAI transcription key is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-missing-key-"));
  const oldKey = process.env.BRAIN_TEST_MISSING_OPENAI_KEY;
  try {
    delete process.env.BRAIN_TEST_MISSING_OPENAI_KEY;
    const audioPath = path.join(root, "voice.ogg");
    await writeFile(audioPath, "fake ogg/opus bytes");
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const api: TelegramBotApi = {
      async call(method, payload) {
        calls.push({ method, payload });
        if (method === "getFile") return { ok: true, result: { file_id: payload?.file_id, file_path: "voice.ogg", file_size: 12 } };
        return { ok: true, result: { message_id: 99 } };
      },
      async downloadFile(filePath) {
        return { localPath: audioPath, filePath, bytes: new TextEncoder().encode("fake ogg/opus bytes") };
      },
    };
    const adapter = new TelegramEntrypointAdapter({
      workspaceId: "personal",
      apiClient: api,
      attachmentHandling: {
        download: true,
        transcriber: new OpenAITelegramAttachmentTranscriber({ apiKeyRef: "env:BRAIN_TEST_MISSING_OPENAI_KEY" }),
        transcribeKinds: ["voice", "audio"],
        transcriptionFailureMode: "codex-chat",
      },
      updates: [
        { update_id: 805, message: { message_id: 5, chat: { id: 123 }, from: { id: 7 }, voice: { file_id: "voice_file", file_unique_id: "voice_unique", mime_type: "audio/ogg" } } },
      ],
    });
    await adapter.start();
    const events = [];
    for await (const event of adapter.inboundEvents()) events.push(event);

    assert.equal(events.length, 0);
    assert.deepEqual(calls.map((call) => call.method), ["setMessageReaction", "getFile"]);
  } finally {
    if (oldKey === undefined) delete process.env.BRAIN_TEST_MISSING_OPENAI_KEY;
    else process.env.BRAIN_TEST_MISSING_OPENAI_KEY = oldKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram adapter drops audio events when configured OpenAI transcription errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-openai-error-"));
  try {
    const audioPath = path.join(root, "song.mp3");
    await writeFile(audioPath, "fake mp3 bytes");
    const api: TelegramBotApi = {
      async call(method, payload) {
        if (method === "getFile") return { ok: true, result: { file_id: payload?.file_id, file_path: "song.mp3", file_size: 12 } };
        throw new Error(`unexpected method ${method}`);
      },
      async downloadFile(filePath) {
        return { localPath: audioPath, filePath, bytes: new TextEncoder().encode("fake mp3 bytes") };
      },
    };
    const client: OpenAIAudioTranscriptionClient = {
      audio: { transcriptions: { async create() { throw new Error("OpenAI transcription failed"); } } },
    };
    const adapter = new TelegramEntrypointAdapter({
      workspaceId: "personal",
      apiClient: api,
      attachmentHandling: {
        download: true,
        transcriber: new OpenAITelegramAttachmentTranscriber({ apiKeyRef: "env:UNUSED_WITH_INJECTED_CLIENT", client }),
        transcribeKinds: ["voice", "audio"],
        transcriptionFailureMode: "codex-chat",
      },
      updates: [
        { update_id: 806, message: { message_id: 6, chat: { id: 123 }, from: { id: 7 }, audio: { file_id: "audio_file", file_unique_id: "audio_unique", file_name: "song.mp3", mime_type: "audio/mpeg" } } },
      ],
    });
    await adapter.start();
    const events = [];
    for await (const event of adapter.inboundEvents()) events.push(event);

    assert.equal(events.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram attachment downloads enforce codex-chat size limits before and after fetch", async () => {
  const beforeLimitApi: TelegramBotApi = {
    downloadMaxBytes: 5,
    async call() { return { ok: true, result: { file_id: "voice_file", file_path: "voice/audio.ogg", file_size: 6 } }; },
    async downloadFile() { throw new Error("should not download oversized Telegram file"); },
  };
  await assert.rejects(
    () => resolveTelegramAttachmentDownload({ kind: "voice", uri: "voice_file", metadata: { telegramFileId: "voice_file" } }, beforeLimitApi),
    /downloadMaxBytes: 6/,
  );

  const afterLimitApi: TelegramBotApi = {
    downloadMaxBytes: 5,
    async call() { return { ok: true, result: { file_id: "voice_file", file_path: "voice/audio.ogg", file_size: 4 } }; },
    async downloadFile(filePath) { return { localPath: "/tmp/audio.ogg", filePath, bytes: new Uint8Array(6) }; },
  };
  await assert.rejects(
    () => resolveTelegramAttachmentDownload({ kind: "voice", uri: "voice_file", metadata: { telegramFileId: "voice_file" } }, afterLimitApi),
    /downloadMaxBytes: 6/,
  );
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

test("TelegramEntrypointAdapter refuses local artifact sends outside configured roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-telegram-send-root-"));
  const allowed = path.join(root, "artifacts");
  const allowedFile = path.join(allowed, "ok.png");
  const deniedFile = path.join(root, "secret.png");
  try {
    await mkdir(allowed, { recursive: true });
    await writeFile(allowedFile, "ok");
    await writeFile(deniedFile, "no");
    const calls: TelegramCallIntent[] = [];
    const adapter = new TelegramEntrypointAdapter({
      workspaceId: "personal",
      allowedSendRoots: [allowed],
      dispatchIntent: (intent, action) => {
        calls.push(intent);
        return { action, status: "sent" };
      },
    });

    const denied = await adapter.dispatch({ type: "send_artifact", path: deniedFile, target: { conversationId: "123" } });
    assert.equal(denied.status, "failed");
    assert.match(denied.error ?? "", /outside allowed roots/);
    assert.equal(calls.length, 0);

    const sent = await adapter.dispatch({ type: "send_artifact", path: allowedFile, target: { conversationId: "123" } });
    assert.equal(sent.status, "sent");
    assert.equal(calls[0]?.payload.photo, allowedFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

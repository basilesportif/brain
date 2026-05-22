import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAITelegramAttachmentTranscriber, type OpenAIAudioTranscriptionClient } from "./index.js";

function fakeEvent() {
  return {
    id: "event-1",
    kind: "attachment" as const,
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    receivedAt: new Date(0).toISOString(),
  };
}

test("OpenAI Telegram transcriber mirrors codex-chat SDK request fields and prompt handling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-openai-transcription-"));
  const oldKey = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "sk-test-transcription";
    await mkdir(path.join(root, "prompts"), { recursive: true });
    const audioPath = path.join(root, "voice.ogg");
    const promptPath = path.join(root, "prompts", "voice-transcription.md");
    await writeFile(audioPath, "fake ogg/opus bytes");
    await writeFile(promptPath, "Prefer Brain, not bran.\n");

    const requests: Record<string, unknown>[] = [];
    let apiKeySeen = "";
    const client: OpenAIAudioTranscriptionClient = {
      audio: {
        transcriptions: {
          async create(request) {
            requests.push(request as Record<string, unknown>);
            return { text: `transcript ${requests.length}` };
          },
        },
      },
    };

    const transcriber = new OpenAITelegramAttachmentTranscriber({
      apiKeyRef: "env:OPENAI_API_KEY",
      model: "gpt-4o-transcribe",
      language: "en",
      promptPath: "prompts/voice-transcription.md",
      rootDir: root,
      createClient(apiKey) {
        apiKeySeen = apiKey;
        return client;
      },
    });

    await assert.doesNotReject(async () => {
      const result = await transcriber.transcribe({ path: audioPath, attachment: { kind: "voice", localPath: audioPath, mimeType: "audio/ogg" }, event: fakeEvent() });
      assert.deepEqual(result, { text: "transcript 1" });
    });

    assert.equal(apiKeySeen, "sk-test-transcription");
    assert.equal(requests[0]?.model, "gpt-4o-transcribe");
    assert.equal(requests[0]?.language, "en");
    assert.equal(requests[0]?.prompt, "Prefer Brain, not bran.\n");
    assert.equal((requests[0]?.file as { path?: string } | undefined)?.path, audioPath);

    await writeFile(promptPath, "Updated vocabulary\n");
    await transcriber.transcribe({ path: audioPath, attachment: { kind: "voice", localPath: audioPath, mimeType: "audio/ogg" }, event: fakeEvent() });
    assert.equal(requests[1]?.prompt, "Updated vocabulary\n");
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI Telegram transcriber omits missing/blank optional fields and returns empty text when API omits it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-openai-transcription-missing-"));
  try {
    const audioPath = path.join(root, "voice.ogg");
    await writeFile(audioPath, "fake ogg/opus bytes");
    const requests: Record<string, unknown>[] = [];
    const client: OpenAIAudioTranscriptionClient = {
      audio: { transcriptions: { async create(request) { requests.push(request as Record<string, unknown>); return {}; } } },
    };
    const transcriber = new OpenAITelegramAttachmentTranscriber({
      apiKeyRef: "env:UNUSED_FOR_INJECTED_CLIENT",
      model: "gpt-4o-mini-transcribe",
      language: "",
      promptPath: "prompts/missing.md",
      rootDir: root,
      client,
    });

    const result = await transcriber.transcribe({ path: audioPath, attachment: { kind: "voice", localPath: audioPath, mimeType: "audio/ogg" }, event: fakeEvent() });
    assert.deepEqual(result, { text: "" });
    assert.equal("language" in requests[0]!, true);
    assert.equal(requests[0]?.language, undefined);
    assert.equal("prompt" in requests[0]!, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

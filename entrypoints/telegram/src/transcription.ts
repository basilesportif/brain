import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { BrainAttachment, EntryPointInboundEvent } from "@brain/entrypoint-protocol";
import type { TelegramAttachmentTranscriber, TelegramTranscriptionResult } from "./index.js";

export interface OpenAITelegramTranscriberOptions {
  apiKeyRef: string;
  model?: string;
  language?: string;
  promptPath?: string;
  rootDir?: string;
  client?: OpenAIAudioTranscriptionClient;
  createClient?: (apiKey: string) => OpenAIAudioTranscriptionClient;
}

export interface OpenAIAudioTranscriptionClient {
  audio: {
    transcriptions: {
      create(request: unknown): Promise<{ text?: string }>;
    };
  };
}

export class OpenAITelegramAttachmentTranscriber implements TelegramAttachmentTranscriber {
  private readonly model: string;
  private readonly language?: string;
  private readonly promptPath?: string;
  private client?: OpenAIAudioTranscriptionClient;

  constructor(private readonly options: OpenAITelegramTranscriberOptions) {
    this.model = options.model ?? "gpt-4o-mini-transcribe";
    this.language = options.language?.trim() ? options.language : undefined;
    this.promptPath = options.promptPath?.trim()
      ? resolveTranscriptionPath(options.rootDir ?? process.cwd(), options.promptPath)
      : undefined;
    this.client = options.client;
  }

  async transcribe(input: { path: string; attachment: BrainAttachment; event: EntryPointInboundEvent }): Promise<TelegramTranscriptionResult> {
    const request: Record<string, unknown> = {
      file: createReadStream(input.path) as never,
      model: this.model,
      language: this.language,
    };
    const prompt = await this.readPrompt();
    if (prompt !== undefined) request.prompt = prompt;
    try {
      const response = await (await this.openAIClient()).audio.transcriptions.create(request);
      return { text: response.text ?? "" };
    } finally {
      destroyRequestFile(request.file);
    }
  }

  private async openAIClient(): Promise<OpenAIAudioTranscriptionClient> {
    if (this.client) return this.client;
    const apiKey = await readSecretRefValue(this.options.apiKeyRef);
    if (!apiKey) throw new Error(`OpenAI transcription API key is missing for ${this.options.apiKeyRef}`);
    this.client = this.options.createClient?.(apiKey) ?? new OpenAI({ apiKey });
    return this.client;
  }

  private async readPrompt(): Promise<string | undefined> {
    if (!this.promptPath) return undefined;
    try {
      const prompt = await readFile(this.promptPath, "utf8");
      return prompt.trim().length > 0 ? prompt : undefined;
    } catch {
      return undefined;
    }
  }
}

export async function readSecretRefValue(ref: string): Promise<string | undefined> {
  const normalized = asSecretRef(ref);
  if (normalized.startsWith("env:")) return process.env[normalized.slice("env:".length)];
  if (normalized.startsWith("file:")) return (await readFile(normalized.slice("file:".length), "utf8")).trim();
  return undefined;
}

export function asSecretRef(ref: string): string {
  return /^(env|file):/.test(ref) ? ref : `env:${ref}`;
}

function resolveTranscriptionPath(rootDir: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(rootDir, candidate);
}

function destroyRequestFile(file: unknown): void {
  const destroy = (file as { destroy?: () => void } | undefined)?.destroy;
  if (typeof destroy === "function") destroy.call(file);
}

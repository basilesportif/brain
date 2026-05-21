import type { BrainEntrypointAdapter, BrainOutboundAction, EntryPointHealth, EntryPointInboundEvent, EntryPointRef, JsonRecord, OutboundDispatchResult } from "@brain/entrypoint-protocol";

export interface TelegramMessageLike {
  message_id: number;
  date?: number;
  text?: string;
  caption?: string;
  chat: { id: number | string; type?: string; title?: string; username?: string };
  from?: { id: number | string; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  message_thread_id?: number;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
  photo?: unknown[];
  document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id?: string; mime_type?: string; file_size?: number };
  audio?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
}

export interface TelegramUpdateLike {
  update_id: number;
  message?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  callback_query?: {
    id: string;
    data?: string;
    message?: TelegramMessageLike;
    from?: TelegramMessageLike["from"];
  };
}

export interface TelegramEntrypointOptions {
  workspaceId: string;
  entrypointId?: string;
  displayName?: string;
}

export interface TelegramEntrypointAdapterOptions extends TelegramEntrypointOptions {
  updates?: Iterable<TelegramUpdateLike> | AsyncIterable<TelegramUpdateLike>;
  dispatchIntent?(intent: TelegramCallIntent, action: BrainOutboundAction): Promise<OutboundDispatchResult> | OutboundDispatchResult;
}

export interface TelegramCallIntent {
  method: string;
  payload: Record<string, unknown>;
}

export class TelegramEntrypointAdapter implements BrainEntrypointAdapter {
  readonly id: string;
  readonly ref: EntryPointRef;
  private started = false;
  private lastEventId?: string;

  constructor(private readonly options: TelegramEntrypointAdapterOptions) {
    this.id = options.entrypointId ?? "telegram-main";
    this.ref = {
      entrypointId: this.id,
      channelKind: "telegram",
      displayName: options.displayName ?? "Telegram",
      capabilities: {
        replies: true,
        edits: true,
        artifactUploads: true,
        statusUpdates: true,
        reactions: true,
        attachments: true,
        commands: true,
      },
    };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async health(): Promise<EntryPointHealth> {
    return {
      ok: this.started,
      entrypointId: this.id,
      detail: this.started ? "started without Telegram network client" : "stopped",
      lastEventId: this.lastEventId,
    };
  }

  async *inboundEvents(): AsyncIterable<EntryPointInboundEvent> {
    for await (const update of toAsyncIterable(this.options.updates ?? [])) {
      const event = telegramUpdateToInboundEvent(update, this.options);
      if (!event) continue;
      this.lastEventId = event.id;
      yield event;
    }
  }

  async dispatch(action: BrainOutboundAction): Promise<OutboundDispatchResult> {
    const intent = outboundActionToTelegramIntent(action);
    if (!intent) return actionDispatchResult(action, intent);
    return this.options.dispatchIntent?.(intent, action) ?? actionDispatchResult(action, intent);
  }
}

export function telegramUpdateToInboundEvent(update: TelegramUpdateLike, options: TelegramEntrypointOptions): EntryPointInboundEvent | undefined {
  const entrypointId = options.entrypointId ?? "telegram-main";
  const message = update.message ?? update.edited_message ?? update.callback_query?.message;
  if (!message && !update.callback_query) return undefined;

  if (update.callback_query) {
    return {
      id: `telegram_callback_${update.update_id}_${update.callback_query.id}`,
      kind: "callback",
      workspaceId: options.workspaceId,
      entrypoint: { entrypointId, channelKind: "telegram", displayName: options.displayName ?? "Telegram" },
      text: update.callback_query.data,
      actor: summarizeActor(update.callback_query.from),
      conversation: message ? summarizeConversation(message) : undefined,
      correlationId: String(update.update_id),
      receivedAt: toIso(message?.date),
      metadata: { telegramUpdateId: update.update_id, callbackQueryId: update.callback_query.id },
    };
  }

  if (!message) return undefined;
  const text = message.text ?? message.caption ?? "";
  const commandMatch = text.match(/^\/([A-Za-z0-9_:-]+)(?:\s+(.*))?$/);
  return {
    id: `telegram_message_${update.update_id}_${message.message_id}`,
    kind: commandMatch ? "command" : attachmentsFrom(message).length > 0 && !text ? "attachment" : "message",
    workspaceId: options.workspaceId,
    entrypoint: { entrypointId, channelKind: "telegram", displayName: options.displayName ?? "Telegram" },
    text,
    command: commandMatch?.[1],
    args: commandMatch?.[2]?.trim().split(/\s+/).filter(Boolean),
    attachments: attachmentsFrom(message),
    actor: summarizeActor(message.from),
    conversation: summarizeConversation(message),
    reply: message.reply_to_message ? {
      externalMessageId: String(message.reply_to_message.message_id),
      snippet: message.reply_to_message.text ?? message.reply_to_message.caption,
    } : undefined,
    correlationId: String(update.update_id),
    receivedAt: toIso(message.date),
    metadata: { telegramUpdateId: update.update_id, telegramMessageId: message.message_id },
  };
}

export function outboundActionToTelegramIntent(action: BrainOutboundAction): TelegramCallIntent | undefined {
  const chatId = action.target?.conversationId;
  const threadId = action.target?.threadId;
  if (action.type === "send_text" || action.type === "request_clarification") {
    return {
      method: "sendMessage",
      payload: compact({
        chat_id: chatId,
        message_thread_id: threadId ? Number(threadId) : undefined,
        text: action.text,
        parse_mode: action.type === "send_text" ? telegramParseMode(action.format) : undefined,
        reply_to_message_id: action.target?.replyToExternalMessageId ? Number(action.target.replyToExternalMessageId) : undefined,
      }),
    };
  }
  if (action.type === "send_artifact") {
    return {
      method: action.asDocument ? "sendDocument" : "sendPhoto",
      payload: compact({
        chat_id: chatId,
        message_thread_id: threadId ? Number(threadId) : undefined,
        [action.asDocument ? "document" : "photo"]: action.path ?? action.uri,
        caption: action.caption,
      }),
    };
  }
  if (action.type === "show_status") {
    const chatAction = action.status === "typing" || action.status === "running" ? "typing" : undefined;
    return chatAction ? { method: "sendChatAction", payload: compact({ chat_id: chatId, action: chatAction }) } : undefined;
  }
  if (action.type === "react") {
    return {
      method: "setMessageReaction",
      payload: compact({ chat_id: chatId, message_id: action.target?.replyToExternalMessageId ? Number(action.target.replyToExternalMessageId) : undefined, reaction: [{ type: "emoji", emoji: action.emoji }] }),
    };
  }
  if (action.type === "edit_message") {
    return {
      method: "editMessageText",
      payload: compact({ chat_id: chatId, message_id: action.externalMessageId ?? action.target?.replyToExternalMessageId, text: action.text }),
    };
  }
  return undefined;
}

export function actionDispatchResult(action: BrainOutboundAction, intent: TelegramCallIntent | undefined): OutboundDispatchResult {
  return intent ? { action, status: "queued" } : { action, status: "skipped", error: `No Telegram intent mapping for ${action.type}` };
}

function summarizeConversation(message: TelegramMessageLike) {
  return {
    id: String(message.chat.id),
    threadId: message.message_thread_id === undefined ? undefined : String(message.message_thread_id),
    label: message.chat.title ?? message.chat.username,
    metadata: compact({ messageId: String(message.message_id), chatType: message.chat.type }) as JsonRecord,
  };
}

function summarizeActor(from: TelegramMessageLike["from"] | undefined) {
  if (!from) return undefined;
  return {
    id: String(from.id),
    username: from.username,
    displayName: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username,
    role: "user" as const,
    metadata: { isBot: from.is_bot ?? false },
  };
}

function attachmentsFrom(message: TelegramMessageLike) {
  const attachments = [];
  if (message.document) attachments.push({ kind: "document" as const, uri: message.document.file_id, originalName: message.document.file_name, mimeType: message.document.mime_type, sizeBytes: message.document.file_size });
  if (message.voice) attachments.push({ kind: "voice" as const, uri: message.voice.file_id, mimeType: message.voice.mime_type, sizeBytes: message.voice.file_size });
  if (message.audio) attachments.push({ kind: "audio" as const, uri: message.audio.file_id, originalName: message.audio.file_name, mimeType: message.audio.mime_type, sizeBytes: message.audio.file_size });
  if (message.photo?.length) attachments.push({ kind: "image" as const, metadata: { variants: message.photo.length } });
  return attachments;
}

function toIso(unixSeconds: number | undefined): string {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : new Date().toISOString();
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}

async function* toAsyncIterable<T>(items: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
  for await (const item of items) yield item;
}

function telegramParseMode(format: "text" | "markdown" | "markdownv2" | undefined): "Markdown" | "MarkdownV2" | undefined {
  if (format === "markdown") return "Markdown";
  if (format === "markdownv2") return "MarkdownV2";
  return undefined;
}

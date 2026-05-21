import type { BrainAttachment, BrainEntrypointAdapter, BrainOutboundAction, EntryPointHealth, EntryPointInboundEvent, EntryPointRef, JsonRecord, OutboundDispatchResult } from "@brain/entrypoint-protocol";

export interface TelegramMessageLike {
  message_id: number;
  date?: number;
  text?: string;
  caption?: string;
  chat: { id: number | string; type?: string; title?: string; username?: string };
  from?: { id: number | string; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  message_thread_id?: number;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
  photo?: Array<{ file_id?: string; file_unique_id?: string; file_size?: number; width?: number; height?: number }>;
  document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id?: string; mime_type?: string; file_size?: number };
  audio?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
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
  adminAllowlist?: TelegramAdminAllowlist;
}

export interface TelegramEntrypointAdapterOptions extends TelegramEntrypointOptions {
  updates?: Iterable<TelegramUpdateLike> | AsyncIterable<TelegramUpdateLike>;
  apiClient?: TelegramBotApi;
  polling?: TelegramPollingOptions;
  dispatchIntent?(intent: TelegramCallIntent, action: BrainOutboundAction): Promise<OutboundDispatchResult> | OutboundDispatchResult;
}

export interface TelegramCallIntent {
  method: string;
  payload: Record<string, unknown>;
}

export interface TelegramAdminAllowlist {
  userIds?: Array<string | number>;
  chatIds?: Array<string | number>;
}

export interface TelegramPollingOptions {
  enabled?: boolean;
  timeoutSec?: number;
  limit?: number;
  maxPolls?: number;
  signal?: AbortSignal;
}

export interface TelegramBotApi {
  call(method: string, payload?: Record<string, unknown>): Promise<unknown>;
  downloadFile?(filePath: string): Promise<TelegramDownloadedFile>;
}

export interface TelegramDownloadedFile {
  uri?: string;
  localPath?: string;
  bytes?: Uint8Array;
  filePath?: string;
}

export interface TelegramFileInfo {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
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
      detail: this.started
        ? (this.options.apiClient ? "started with Telegram API client boundary" : "started without Telegram network client")
        : "stopped",
      lastEventId: this.lastEventId,
    };
  }

  async *inboundEvents(): AsyncIterable<EntryPointInboundEvent> {
    for await (const update of this.updateSource()) {
      const event = telegramUpdateToInboundEvent(update, this.options);
      if (!event) continue;
      this.lastEventId = event.id;
      yield event;
    }
  }

  async dispatch(action: BrainOutboundAction): Promise<OutboundDispatchResult> {
    const intent = outboundActionToTelegramIntent(action);
    if (!intent) return actionDispatchResult(action, intent);
    if (this.options.dispatchIntent) return this.options.dispatchIntent(intent, action);
    if (this.options.apiClient) {
      try {
        const response = await this.options.apiClient.call(intent.method, intent.payload);
        return telegramApiDispatchResult(action, response);
      } catch (error) {
        return { action, status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    }
    return actionDispatchResult(action, intent);
  }

  async resolveAttachmentDownload(attachment: BrainAttachment): Promise<BrainAttachment> {
    if (!this.options.apiClient) throw new Error("Telegram API client is required to resolve attachment downloads");
    return resolveTelegramAttachmentDownload(attachment, this.options.apiClient);
  }

  private updateSource(): AsyncIterable<TelegramUpdateLike> {
    if (this.options.updates) return toAsyncIterable(this.options.updates);
    if (this.options.apiClient && this.options.polling?.enabled) return pollTelegramUpdates(this.options.apiClient, this.options.polling);
    return toAsyncIterable([]);
  }
}

export function telegramUpdateToInboundEvent(update: TelegramUpdateLike, options: TelegramEntrypointOptions): EntryPointInboundEvent | undefined {
  const entrypointId = options.entrypointId ?? "telegram-main";
  const message = update.message ?? update.edited_message ?? update.callback_query?.message;
  if (!message && !update.callback_query) return undefined;

  if (update.callback_query) {
    const event: EntryPointInboundEvent = {
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
    return isTelegramEventAllowed(event, options.adminAllowlist) ? event : undefined;
  }

  if (!message) return undefined;
  const text = message.text ?? message.caption ?? "";
  const commandMatch = text.match(/^\/([A-Za-z0-9_:-]+)(?:\s+(.*))?$/);
  const event: EntryPointInboundEvent = {
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
  return isTelegramEventAllowed(event, options.adminAllowlist) ? event : undefined;
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

export async function* pollTelegramUpdates(api: TelegramBotApi, options: TelegramPollingOptions = {}): AsyncIterable<TelegramUpdateLike> {
  let offset: number | undefined;
  let polls = 0;
  while (!options.signal?.aborted && (options.maxPolls === undefined || polls < options.maxPolls)) {
    polls++;
    const response = await api.call("getUpdates", compact({
      offset,
      timeout: options.timeoutSec ?? 30,
      limit: options.limit ?? 50,
      allowed_updates: ["message", "edited_message", "callback_query"],
    }));
    const updates = telegramApiResult<TelegramUpdateLike[]>(response, []);
    for (const update of updates) {
      offset = update.update_id + 1;
      yield update;
    }
    if (updates.length === 0 && options.maxPolls !== undefined) return;
  }
}

export function handleTelegramWebhookUpdate(update: TelegramUpdateLike, options: TelegramEntrypointOptions & { expectedSecretToken?: string }, receivedSecretToken?: string): EntryPointInboundEvent | undefined {
  if (options.expectedSecretToken && receivedSecretToken !== options.expectedSecretToken) {
    throw new Error("Telegram webhook secret token mismatch");
  }
  return telegramUpdateToInboundEvent(update, options);
}

export async function resolveTelegramAttachmentDownload(attachment: BrainAttachment, api: TelegramBotApi): Promise<BrainAttachment> {
  const fileId = typeof attachment.metadata?.telegramFileId === "string" ? attachment.metadata.telegramFileId : attachment.uri;
  if (!fileId) return attachment;
  const fileInfo = telegramApiResult<TelegramFileInfo>(await api.call("getFile", { file_id: fileId }));
  const downloaded = fileInfo.file_path && api.downloadFile ? await api.downloadFile(fileInfo.file_path) : undefined;
  return {
    ...attachment,
    uri: downloaded?.uri ?? attachment.uri,
    localPath: downloaded?.localPath ?? attachment.localPath,
    sizeBytes: fileInfo.file_size ?? attachment.sizeBytes,
    metadata: compact({
      ...(attachment.metadata ?? {}),
      telegramFileId: fileInfo.file_id,
      telegramFileUniqueId: fileInfo.file_unique_id,
      telegramFilePath: fileInfo.file_path,
      downloadedFilePath: downloaded?.filePath,
      hasDownloadedBytes: downloaded?.bytes ? true : undefined,
    }) as JsonRecord,
  };
}

export class TelegramBotApiClient implements TelegramBotApi {
  constructor(private readonly options: { token?: string; baseUrl?: string; fetchImpl?: typeof fetch }) {}

  async call(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.options.token) throw new Error("Telegram bot token is not configured");
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.baseUrl()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json() as TelegramApiResponse;
    if (!data.ok) throw new Error(data.description ?? `Telegram API ${method} failed`);
    return data;
  }

  async downloadFile(filePath: string): Promise<TelegramDownloadedFile> {
    if (!this.options.token) throw new Error("Telegram bot token is not configured");
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.fileBaseUrl()}/${filePath}`);
    if (!response.ok) throw new Error(`Telegram file download failed with HTTP ${response.status}`);
    return { bytes: new Uint8Array(await response.arrayBuffer()), filePath };
  }

  private baseUrl(): string {
    return `${this.options.baseUrl ?? "https://api.telegram.org"}/bot${this.options.token}`;
  }

  private fileBaseUrl(): string {
    return `${this.options.baseUrl ?? "https://api.telegram.org"}/file/bot${this.options.token}`;
  }
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
  const attachments: BrainAttachment[] = [];
  if (message.document) attachments.push({ kind: "document", uri: message.document.file_id, originalName: message.document.file_name, mimeType: message.document.mime_type, sizeBytes: message.document.file_size, metadata: compact({ telegramFileId: message.document.file_id }) as JsonRecord });
  if (message.voice) attachments.push({ kind: "voice", uri: message.voice.file_id, mimeType: message.voice.mime_type, sizeBytes: message.voice.file_size, metadata: compact({ telegramFileId: message.voice.file_id }) as JsonRecord });
  if (message.audio) attachments.push({ kind: "audio", uri: message.audio.file_id, originalName: message.audio.file_name, mimeType: message.audio.mime_type, sizeBytes: message.audio.file_size, metadata: compact({ telegramFileId: message.audio.file_id }) as JsonRecord });
  if (message.video) attachments.push({ kind: "video", uri: message.video.file_id, originalName: message.video.file_name, mimeType: message.video.mime_type, sizeBytes: message.video.file_size, metadata: compact({ telegramFileId: message.video.file_id }) as JsonRecord });
  if (message.photo?.length) {
    const largest = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    attachments.push({ kind: "image", uri: largest?.file_id, sizeBytes: largest?.file_size, metadata: compact({ variants: message.photo.length, telegramFileId: largest?.file_id, width: largest?.width, height: largest?.height }) as JsonRecord });
  }
  return attachments;
}

function telegramApiDispatchResult(action: BrainOutboundAction, response: unknown): OutboundDispatchResult {
  const result = telegramApiResult<Record<string, unknown>>(response, {});
  const messageId = result && typeof result.message_id === "number" ? String(result.message_id) : undefined;
  return { action, status: "sent", externalMessageId: messageId };
}

function telegramApiResult<T>(response: unknown, fallback?: T): T {
  const record = response && typeof response === "object" && !Array.isArray(response) ? response as TelegramApiResponse<T> : undefined;
  if (!record) return fallback as T;
  if (record.ok === false) throw new Error(record.description ?? "Telegram API returned ok=false");
  return (record.result ?? fallback) as T;
}

function isTelegramEventAllowed(event: EntryPointInboundEvent, allowlist: TelegramAdminAllowlist | undefined): boolean {
  if (!allowlist) return true;
  const users = new Set((allowlist.userIds ?? []).map(String));
  const chats = new Set((allowlist.chatIds ?? []).map(String));
  const userOk = users.size === 0 || (event.actor?.id !== undefined && users.has(String(event.actor.id)));
  const chatOk = chats.size === 0 || (event.conversation?.id !== undefined && chats.has(String(event.conversation.id)));
  return userOk && chatOk;
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

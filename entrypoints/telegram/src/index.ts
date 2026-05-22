import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomInt } from "node:crypto";
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
  document?: { file_id?: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id?: string; file_unique_id?: string; mime_type?: string; file_size?: number };
  audio?: { file_id?: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id?: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number };
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
  pairing?: TelegramPairingOptions;
  attachmentHandling?: TelegramAttachmentHandlingOptions;
  dispatchIntent?(intent: TelegramCallIntent, action: BrainOutboundAction): Promise<OutboundDispatchResult> | OutboundDispatchResult;
}

export interface TelegramCallIntent {
  method: string;
  payload: Record<string, unknown>;
}

export interface TelegramAdminAllowlist {
  userIds?: Array<string | number>;
  chatIds?: Array<string | number>;
  /** When true, an empty allowlist blocks normal messages unless paired state allows them. */
  denyWhenEmpty?: boolean;
}

export interface TelegramPairedUser {
  userId: string;
  isAdmin?: boolean;
  pairedAt?: string;
}

export interface TelegramPairedChat {
  chatId: string;
  pairedAt?: string;
}

export interface TelegramPairingStore {
  init?(): Promise<void>;
  listUsers(): Promise<TelegramPairedUser[]>;
  listChats(): Promise<TelegramPairedChat[]>;
  addIdentity(userId: string | number, chatId: string | number, isAdmin?: boolean): Promise<void>;
  readPairingCode(): Promise<string | undefined>;
  writePairingCode(code: string): Promise<void>;
  deletePairingCode(): Promise<void>;
}

export interface TelegramPairingOptions {
  enabled?: boolean;
  enabledOnEmptyAllowlist?: boolean;
  /**
   * `first-user` is the default bootstrap: when no explicit allowlist and no
   * paired identities exist, the first Telegram user/chat that sends a message
   * is persisted as the admin pair. `code` preserves the optional advanced
   * `/pair <code>` flow.
   */
  mode?: "first-user" | "code";
  store: TelegramPairingStore;
  codeFactory?: () => string;
  replyOnPair?: boolean;
}

export interface TelegramPairingStatus {
  enabled: boolean;
  pending: boolean;
  users: number;
  chats: number;
  codePresent: boolean;
}

export interface TelegramPollingOptions {
  enabled?: boolean;
  timeoutSec?: number;
  limit?: number;
  maxPolls?: number;
  initialOffset?: number;
  allowedUpdates?: string[];
  stateStore?: TelegramPollingStateStore;
  retryDelayMs?: number;
  onError?(error: Error, context: { poll: number; offset?: number }): void | Promise<void>;
  signal?: AbortSignal;
}

export interface TelegramTranscriptionResult {
  text: string;
}

export interface TelegramAttachmentTranscriber {
  transcribe(input: { path: string; attachment: BrainAttachment; event: EntryPointInboundEvent }): Promise<TelegramTranscriptionResult>;
}

export interface TelegramAttachmentHandlingOptions {
  /**
   * Resolve Telegram file ids to local/remote downloaded files before yielding
   * the inbound event. This is intentionally opt-in for live runtimes because it
   * may contact the Telegram file API and write private data under downloadDir.
   */
  download?: boolean;
  /**
   * Optional transcriber seam for voice/audio/video attachments that were
   * resolved to local paths. Brain does not prescribe an OpenAI dependency here;
   * operators can inject an implementation from private runtime configuration.
   */
  transcriber?: TelegramAttachmentTranscriber;
  transcribeKinds?: Array<BrainAttachment["kind"]>;
  appendTranscriptToText?: boolean;
}

export interface TelegramBotApi {
  call(method: string, payload?: Record<string, unknown>): Promise<unknown>;
  downloadFile?(filePath: string): Promise<TelegramDownloadedFile>;
  downloadMaxBytes?: number;
}

export interface TelegramTokenOptions {
  token?: string;
  tokenEnv?: string;
  tokenFile?: string;
  required?: boolean;
}

export interface TelegramTokenLoadResult {
  present: boolean;
  source?: "literal" | "env" | "file";
  token?: string;
  redacted: string;
}

export interface TelegramPollingStateStore {
  getOffset(): Promise<number | undefined>;
  setOffset(offset: number): Promise<void>;
}

export interface TelegramWebhookServerOptions extends TelegramEntrypointOptions {
  host?: string;
  port?: number;
  path?: string;
  expectedSecretToken?: string;
  maxBodyBytes?: number;
  onEvent(event: EntryPointInboundEvent, update: TelegramUpdateLike): Promise<void> | void;
  onError?(error: Error, update?: unknown): Promise<void> | void;
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

export async function loadTelegramToken(options: TelegramTokenOptions = {}): Promise<TelegramTokenLoadResult> {
  const literal = normalizeToken(options.token);
  if (literal) return { present: true, source: "literal", token: literal, redacted: redactToken(literal) };
  if (options.tokenEnv) {
    const fromEnv = normalizeToken(process.env[options.tokenEnv]);
    if (fromEnv) return { present: true, source: "env", token: fromEnv, redacted: redactToken(fromEnv) };
  }
  if (options.tokenFile) {
    try {
      const fromFile = normalizeToken(await readFile(options.tokenFile, "utf8"));
      if (fromFile) return { present: true, source: "file", token: fromFile, redacted: redactToken(fromFile) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (options.required) throw new Error("Telegram bot token is not configured");
  return { present: false, redacted: "absent" };
}

export class FileTelegramPollingStateStore implements TelegramPollingStateStore {
  constructor(readonly filePath: string) {}

  async getOffset(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { offset?: unknown };
      return typeof parsed.offset === "number" && Number.isSafeInteger(parsed.offset) ? parsed.offset : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async setOffset(offset: number): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(this.filePath), `.telegram-offset.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temp, `${JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}


export class FileTelegramPairingStore implements TelegramPairingStore {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async listUsers(): Promise<TelegramPairedUser[]> {
    return this.readJson<TelegramPairedUser[]>("telegram_users.json", []);
  }

  async listChats(): Promise<TelegramPairedChat[]> {
    return this.readJson<TelegramPairedChat[]>("telegram_chats.json", []);
  }

  async addIdentity(userId: string | number, chatId: string | number, isAdmin = true): Promise<void> {
    await this.init();
    const pairedAt = new Date().toISOString();
    const userKey = String(userId);
    const chatKey = String(chatId);
    const users = await this.listUsers();
    if (!users.some((user) => user.userId === userKey)) users.push({ userId: userKey, isAdmin, pairedAt });
    const chats = await this.listChats();
    if (!chats.some((chat) => chat.chatId === chatKey)) chats.push({ chatId: chatKey, pairedAt });
    await this.writeJson("telegram_users.json", users);
    await this.writeJson("telegram_chats.json", chats);
  }

  async readPairingCode(): Promise<string | undefined> {
    try {
      const code = (await readFile(this.path("pairing_code.txt"), "utf8")).trim();
      return code || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writePairingCode(code: string): Promise<void> {
    await this.init();
    await atomicWriteText(this.path("pairing_code.txt"), `${code.trim()}\n`, 0o600);
  }

  async deletePairingCode(): Promise<void> {
    await unlink(this.path("pairing_code.txt")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path(file), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await this.init();
    await atomicWriteText(this.path(file), `${JSON.stringify(value, null, 2)}\n`, 0o600);
  }

  private path(file: string): string {
    const resolved = path.resolve(this.root, file);
    if (!isInsidePath(resolved, path.resolve(this.root))) throw new Error(`Telegram pairing path escapes root: ${file}`);
    return resolved;
  }
}

export class TelegramEntrypointAdapter implements BrainEntrypointAdapter {
  readonly id: string;
  readonly ref: EntryPointRef;
  private started = false;
  private lastEventId?: string;
  private pollingController?: AbortController;

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
    await this.preparePairing();
    if (this.options.polling?.enabled) this.pollingController = new AbortController();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.pollingController?.abort("telegram entrypoint stopped");
    this.pollingController = undefined;
  }

  async health(): Promise<EntryPointHealth> {
    const pairing = await this.pairingStatus().catch(() => undefined);
    const pairingDetail = pairing?.enabled ? `; pairing=${pairing.pending ? "pending" : "ready"} users=${pairing.users} chats=${pairing.chats}` : "";
    return {
      ok: this.started,
      entrypointId: this.id,
      detail: this.started
        ? `${this.options.apiClient ? "started with Telegram API client boundary" : "started without Telegram network client"}${pairingDetail}`
        : "stopped",
      lastEventId: this.lastEventId,
    };
  }

  async *inboundEvents(): AsyncIterable<EntryPointInboundEvent> {
    for await (const update of this.updateSource()) {
      if (await this.handlePairingUpdate(update)) continue;
      const event = telegramUpdateToInboundEvent(update, { ...this.options, adminAllowlist: undefined });
      if (!event) continue;
      await this.pairFirstUserIfNeeded(event);
      if (!(await this.isEventAllowed(event))) continue;
      const prepared = await this.prepareInboundEvent(event);
      this.lastEventId = prepared.id;
      yield prepared;
    }
  }

  async dispatch(action: BrainOutboundAction): Promise<OutboundDispatchResult> {
    const intent = outboundActionToTelegramIntent(action);
    if (!intent) return actionDispatchResult(action, intent);
    if (this.options.dispatchIntent) return this.options.dispatchIntent(intent, action);
    if (this.options.apiClient) {
      try {
        const response = await this.options.apiClient.call(intent.method, intent.payload);
        const result = telegramApiDispatchResult(action, response);
        if (result.status === "sent" && action.type === "send_artifact" && action.deleteAfterSend && action.path) {
          await rm(action.path, { force: true }).catch(() => undefined);
        }
        return result;
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

  async pairingStatus(): Promise<TelegramPairingStatus> {
    const pairing = this.options.pairing;
    if (!pairing?.enabled) return { enabled: false, pending: false, users: 0, chats: 0, codePresent: false };
    await pairing.store.init?.();
    const [users, chats, code] = await Promise.all([pairing.store.listUsers(), pairing.store.listChats(), pairing.store.readPairingCode()]);
    const pendingFirstUser = pairingMode(pairing) === "first-user" && (await this.shouldEnablePairing(pairing));
    return { enabled: true, pending: pendingFirstUser || Boolean(code), users: users.length, chats: chats.length, codePresent: Boolean(code) };
  }

  private async preparePairing(): Promise<void> {
    const pairing = this.options.pairing;
    if (!pairing?.enabled) return;
    await pairing.store.init?.();
    const shouldEnable = await this.shouldEnablePairing(pairing);
    if (!shouldEnable) return;
    if (pairingMode(pairing) === "first-user") return;
    const existing = await pairing.store.readPairingCode();
    if (!existing) await pairing.store.writePairingCode((pairing.codeFactory?.() ?? makeTelegramPairingCode()).trim());
  }

  private async shouldEnablePairing(pairing: TelegramPairingOptions): Promise<boolean> {
    if (pairing.enabledOnEmptyAllowlist === false) return false;
    const [users, chats] = await Promise.all([pairing.store.listUsers(), pairing.store.listChats()]);
    const configuredUsers = this.options.adminAllowlist?.userIds?.length ?? 0;
    const configuredChats = this.options.adminAllowlist?.chatIds?.length ?? 0;
    return configuredUsers + configuredChats + users.length + chats.length === 0;
  }

  private async handlePairingUpdate(update: TelegramUpdateLike): Promise<boolean> {
    const pairing = this.options.pairing;
    if (!pairing?.enabled) return false;
    if (pairingMode(pairing) !== "code" && !(await pairing.store.readPairingCode())) return false;
    const command = telegramPairCommand(update);
    if (!command) return false;
    const expected = await pairing.store.readPairingCode();
    const ok = Boolean(expected && command.code === expected);
    if (ok) {
      await pairing.store.addIdentity(command.userId, command.chatId, true);
      await pairing.store.deletePairingCode();
    }
    this.lastEventId = `telegram_pair_${update.update_id}_${command.messageId}`;
    if (pairing.replyOnPair !== false && this.options.apiClient) {
      const text = ok ? `Paired user ${command.userId} and chat ${command.chatId}.` : "Pairing failed.";
      await this.options.apiClient.call("sendMessage", compact({ chat_id: command.chatId, text, reply_to_message_id: command.messageId })).catch(() => undefined);
    }
    return true;
  }

  private async isEventAllowed(event: EntryPointInboundEvent): Promise<boolean> {
    const pairing = this.options.pairing;
    if (!pairing?.enabled) return isTelegramEventAllowed(event, this.options.adminAllowlist);
    const [users, chats] = await Promise.all([pairing.store.listUsers(), pairing.store.listChats()]);
    return isTelegramEventAllowed(event, {
      ...this.options.adminAllowlist,
      userIds: [...(this.options.adminAllowlist?.userIds ?? []), ...users.map((user) => user.userId)],
      chatIds: [...(this.options.adminAllowlist?.chatIds ?? []), ...chats.map((chat) => chat.chatId)],
      denyWhenEmpty: this.options.adminAllowlist?.denyWhenEmpty ?? true,
    });
  }

  private async pairFirstUserIfNeeded(event: EntryPointInboundEvent): Promise<void> {
    const pairing = this.options.pairing;
    if (!pairing?.enabled || pairingMode(pairing) !== "first-user") return;
    if (!(await this.shouldEnablePairing(pairing))) return;
    const userId = event.actor?.id;
    const chatId = event.conversation?.id;
    if (userId === undefined || chatId === undefined) return;
    await pairing.store.addIdentity(userId, chatId, true);
    if (pairing.replyOnPair !== false && this.options.apiClient) {
      await this.options.apiClient.call("sendMessage", compact({
        chat_id: chatId,
        text: "Paired this Telegram user and chat as the Brain admin.",
        reply_to_message_id: typeof event.metadata?.telegramMessageId === "number" ? event.metadata.telegramMessageId : undefined,
      })).catch(() => undefined);
    }
  }

  private updateSource(): AsyncIterable<TelegramUpdateLike> {
    if (this.options.updates) return toAsyncIterable(this.options.updates);
    if (this.options.apiClient && this.options.polling?.enabled) return pollTelegramUpdates(this.options.apiClient, { ...this.options.polling, signal: this.pollingController?.signal ?? this.options.polling.signal });
    return toAsyncIterable([]);
  }

  private async prepareInboundEvent(event: EntryPointInboundEvent): Promise<EntryPointInboundEvent> {
    const handling = this.options.attachmentHandling;
    if (!handling || !event.attachments?.length) return event;

    const attachments: BrainAttachment[] = [];
    const transcriptBlocks: Array<{ attachment: BrainAttachment; text: string }> = [];
    for (const attachment of event.attachments) {
      let next = attachment;
      if (handling.download) {
        try {
          next = await this.resolveAttachmentDownload(next);
        } catch (error) {
          next = {
            ...next,
            metadata: compact({
              ...(next.metadata ?? {}),
              downloadError: error instanceof Error ? error.message : String(error),
            }) as JsonRecord,
          };
        }
      }

      if (shouldTranscribeAttachment(next, handling)) {
        try {
          const transcription = await handling.transcriber?.transcribe({ path: next.localPath as string, attachment: next, event });
          if (transcription?.text?.trim()) {
            const text = transcription.text;
            transcriptBlocks.push({ attachment: next, text });
            next = {
              ...next,
              metadata: compact({
                ...(next.metadata ?? {}),
                transcript: text,
              }) as JsonRecord,
            };
          }
        } catch (error) {
          next = {
            ...next,
            metadata: compact({
              ...(next.metadata ?? {}),
              transcriptionError: error instanceof Error ? error.message : String(error),
            }) as JsonRecord,
          };
        }
      }
      attachments.push(next);
    }

    const appendTranscript = handling.appendTranscriptToText !== false && transcriptBlocks.length > 0;
    return {
      ...event,
      text: appendTranscript ? appendTranscriptBlocks(event.text, transcriptBlocks) : event.text,
      attachments,
    };
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
    const endpoint = telegramArtifactEndpoint(action);
    return {
      method: endpoint.method,
      payload: compact({
        chat_id: chatId,
        message_thread_id: threadId ? Number(threadId) : undefined,
        [endpoint.field]: action.path ?? action.uri,
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
  let offset = options.initialOffset ?? await options.stateStore?.getOffset();
  let polls = 0;
  while (!options.signal?.aborted && (options.maxPolls === undefined || polls < options.maxPolls)) {
    polls++;
    try {
      const response = await api.call("getUpdates", compact({
        offset,
        timeout: options.timeoutSec ?? 30,
        limit: options.limit ?? 50,
        allowed_updates: options.allowedUpdates ?? ["message", "edited_message", "callback_query"],
      }));
      const updates = telegramApiResult<TelegramUpdateLike[]>(response, []);
      for (const update of updates) {
        offset = update.update_id + 1;
        await options.stateStore?.setOffset(offset);
        yield update;
      }
      if (updates.length === 0 && options.maxPolls !== undefined) return;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!options.onError) throw normalized;
      await options.onError(normalized, { poll: polls, offset });
      if (options.maxPolls !== undefined) return;
      await delay(options.retryDelayMs ?? 1_000, options.signal);
    }
  }
}

export function handleTelegramWebhookUpdate(update: TelegramUpdateLike, options: TelegramEntrypointOptions & { expectedSecretToken?: string }, receivedSecretToken?: string): EntryPointInboundEvent | undefined {
  if (options.expectedSecretToken && receivedSecretToken !== options.expectedSecretToken) {
    throw new Error("Telegram webhook secret token mismatch");
  }
  return telegramUpdateToInboundEvent(update, options);
}

export class TelegramWebhookServer {
  private server?: Server;

  constructor(private readonly options: TelegramWebhookServerOptions) {}

  async start(): Promise<{ host: string; port: number; path: string }> {
    if (this.server?.listening) return this.address();
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", () => resolve());
    });
    return this.address();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server || !server.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST") return respondJson(res, 405, { ok: false, error: "method not allowed" });
      if (new URL(req.url ?? "/", "http://localhost").pathname !== (this.options.path ?? "/telegram/webhook")) {
        return respondJson(res, 404, { ok: false, error: "not found" });
      }
      const raw = await readRequestBody(req, this.options.maxBodyBytes ?? 1_000_000);
      const update = JSON.parse(raw) as TelegramUpdateLike;
      const event = handleTelegramWebhookUpdate(update, this.options, headerValue(req.headers["x-telegram-bot-api-secret-token"]));
      if (event) await this.options.onEvent(event, update);
      return respondJson(res, 200, { ok: true, accepted: Boolean(event) });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await this.options.onError?.(normalized);
      return respondJson(res, /secret token/i.test(normalized.message) ? 401 : 400, { ok: false, error: normalized.message });
    }
  }

  private address(): { host: string; port: number; path: string } {
    const address = this.server?.address();
    const port = typeof address === "object" && address ? address.port : this.options.port ?? 0;
    return { host: this.options.host ?? "127.0.0.1", port, path: this.options.path ?? "/telegram/webhook" };
  }
}

export function createTelegramWebhookServer(options: TelegramWebhookServerOptions): TelegramWebhookServer {
  return new TelegramWebhookServer(options);
}

export async function resolveTelegramAttachmentDownload(attachment: BrainAttachment, api: TelegramBotApi): Promise<BrainAttachment> {
  const fileId = typeof attachment.metadata?.telegramFileId === "string" ? attachment.metadata.telegramFileId : attachment.uri;
  if (!fileId) return attachment;
  const fileInfo = telegramApiResult<TelegramFileInfo>(await api.call("getFile", { file_id: fileId }));
  if (fileInfo.file_size !== undefined && api.downloadMaxBytes !== undefined && fileInfo.file_size > api.downloadMaxBytes) {
    throw new Error(`Telegram file exceeds downloadMaxBytes: ${fileInfo.file_size}`);
  }
  const downloaded = fileInfo.file_path && api.downloadFile ? await api.downloadFile(fileInfo.file_path) : undefined;
  if (downloaded?.bytes && api.downloadMaxBytes !== undefined && downloaded.bytes.byteLength > api.downloadMaxBytes) {
    throw new Error(`Telegram file exceeds downloadMaxBytes: ${downloaded.bytes.byteLength}`);
  }
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
  readonly downloadMaxBytes?: number;

  constructor(private readonly options: { token?: string; tokenRef?: TelegramTokenOptions; baseUrl?: string; downloadDir?: string; downloadMaxBytes?: number; fetchImpl?: typeof fetch }) {
    this.downloadMaxBytes = options.downloadMaxBytes;
  }

  static async fromTokenRef(options: TelegramTokenOptions & { baseUrl?: string; downloadDir?: string; downloadMaxBytes?: number; fetchImpl?: typeof fetch }): Promise<TelegramBotApiClient> {
    const loaded = await loadTelegramToken({ ...options, required: options.required ?? true });
    return new TelegramBotApiClient({ token: loaded.token, baseUrl: options.baseUrl, downloadDir: options.downloadDir, downloadMaxBytes: options.downloadMaxBytes, fetchImpl: options.fetchImpl });
  }

  async call(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const token = await this.token();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const uploadForm = await telegramUploadForm(payload);
    const response = await fetchImpl(`${this.baseUrl(token)}/${method}`, uploadForm
      ? { method: "POST", body: uploadForm }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
    const data = await response.json() as TelegramApiResponse;
    if (!data.ok) throw new Error(data.description ?? `Telegram API ${method} failed`);
    return data;
  }

  async downloadFile(filePath: string): Promise<TelegramDownloadedFile> {
    const token = await this.token();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.fileBaseUrl(token)}/${filePath}`);
    if (!response.ok) throw new Error(`Telegram file download failed with HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (this.options.downloadDir) {
      await mkdir(this.options.downloadDir, { recursive: true, mode: 0o700 });
      const localPath = path.join(this.options.downloadDir, safeTelegramFileName(filePath));
      await writeFile(localPath, bytes, { mode: 0o600 });
      return { bytes, localPath, uri: `file://${localPath}`, filePath };
    }
    return { bytes, filePath };
  }

  private async token(): Promise<string> {
    const loaded = await loadTelegramToken({ ...(this.options.tokenRef ?? {}), token: this.options.token ?? this.options.tokenRef?.token, required: true });
    if (!loaded.token) throw new Error("Telegram bot token is not configured");
    return loaded.token;
  }

  private baseUrl(token: string): string {
    return `${this.options.baseUrl ?? "https://api.telegram.org"}/bot${token}`;
  }

  private fileBaseUrl(token: string): string {
    return `${this.options.baseUrl ?? "https://api.telegram.org"}/file/bot${token}`;
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
  if (message.document) attachments.push({ kind: "document", uri: message.document.file_id, originalName: message.document.file_name, mimeType: message.document.mime_type, sizeBytes: message.document.file_size, metadata: compact({ telegramFileId: message.document.file_id, telegramFileUniqueId: message.document.file_unique_id }) as JsonRecord });
  if (message.voice) attachments.push({ kind: "voice", uri: message.voice.file_id, mimeType: message.voice.mime_type, sizeBytes: message.voice.file_size, metadata: compact({ telegramFileId: message.voice.file_id, telegramFileUniqueId: message.voice.file_unique_id }) as JsonRecord });
  if (message.audio) attachments.push({ kind: "audio", uri: message.audio.file_id, originalName: message.audio.file_name, mimeType: message.audio.mime_type, sizeBytes: message.audio.file_size, metadata: compact({ telegramFileId: message.audio.file_id, telegramFileUniqueId: message.audio.file_unique_id }) as JsonRecord });
  if (message.video) attachments.push({ kind: "video", uri: message.video.file_id, originalName: message.video.file_name, mimeType: message.video.mime_type, sizeBytes: message.video.file_size, metadata: compact({ telegramFileId: message.video.file_id, telegramFileUniqueId: message.video.file_unique_id }) as JsonRecord });
  if (message.photo?.length) {
    const largest = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    attachments.push({ kind: "image", uri: largest?.file_id, sizeBytes: largest?.file_size, metadata: compact({ variants: message.photo.length, telegramFileId: largest?.file_id, telegramFileUniqueId: largest?.file_unique_id, width: largest?.width, height: largest?.height }) as JsonRecord });
  }
  return attachments;
}

function shouldTranscribeAttachment(attachment: BrainAttachment, handling: TelegramAttachmentHandlingOptions): boolean {
  if (!handling.transcriber || !attachment.localPath) return false;
  const transcribeKinds = new Set((handling.transcribeKinds ?? ["voice", "audio"]).map(String));
  return transcribeKinds.has(String(attachment.kind));
}

function appendTranscriptBlocks(existingText: string | undefined, blocks: Array<{ attachment: BrainAttachment; text: string }>): string {
  let output = existingText ?? "";
  for (const [index, block] of blocks.entries()) {
    const audioPath = block.attachment.localPath ? `Audio path: ${block.attachment.localPath}` : undefined;
    if (block.attachment.kind === "voice") {
      output = [
        output.trim(),
        "Voice transcript:",
        block.text,
        "",
        audioPath,
      ].filter((value) => value !== undefined && value !== "").join("\n");
    } else if (block.attachment.kind === "audio") {
      output = [
        "Audio transcript:",
        block.text,
        "",
        audioPath,
      ].filter((value) => value !== undefined && value !== "").join("\n");
    } else {
      output = [
        output.trim(),
        `[Transcript ${index + 1}]`,
        block.text,
      ].filter(Boolean).join("\n\n");
    }
  }
  return output;
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
  if (allowlist.denyWhenEmpty && users.size === 0 && chats.size === 0) return false;
  const userOk = users.size === 0 || (event.actor?.id !== undefined && users.has(String(event.actor.id)));
  const chatOk = chats.size === 0 || (event.conversation?.id !== undefined && chats.has(String(event.conversation.id)));
  return userOk && chatOk;
}

function telegramArtifactEndpoint(action: Extract<BrainOutboundAction, { type: "send_artifact" }>): { method: string; field: string } {
  const method = typeof action.metadata?.telegramMethod === "string" ? action.metadata.telegramMethod : undefined;
  if (method && ["sendDocument", "sendPhoto", "sendVoice", "sendAudio", "sendVideo"].includes(method)) {
    return { method, field: method.replace(/^send/, "").toLowerCase() };
  }
  if (action.asDocument) return { method: "sendDocument", field: "document" };
  if (action.mimeType?.startsWith("video/")) return { method: "sendVideo", field: "video" };
  if (action.mimeType?.startsWith("audio/")) {
    if (/ogg|opus|voice/i.test(action.mimeType) || /\.ogg$/i.test(action.path ?? action.uri ?? "")) return { method: "sendVoice", field: "voice" };
    return { method: "sendAudio", field: "audio" };
  }
  return { method: "sendPhoto", field: "photo" };
}

async function telegramUploadForm(payload: Record<string, unknown>): Promise<FormData | undefined> {
  const uploadFields = ["photo", "document", "voice", "audio", "video"];
  const uploadField = uploadFields.find((field) => typeof payload[field] === "string" && isLikelyLocalPath(payload[field] as string));
  if (!uploadField) return undefined;
  const filePath = payload[uploadField] as string;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (key === uploadField) {
      const bytes = await readFile(filePath);
      form.append(key, new Blob([bytes], { type: telegramUploadMimeType(uploadField, payload) }), path.basename(filePath));
    } else if (typeof value === "object") {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

function telegramUploadMimeType(field: string, payload: Record<string, unknown>): string {
  if (typeof payload.mime_type === "string") return payload.mime_type;
  if (field === "photo") return "image/jpeg";
  if (field === "voice") return "audio/ogg";
  if (field === "audio") return "audio/mpeg";
  if (field === "video") return "video/mp4";
  return "application/octet-stream";
}

function isLikelyLocalPath(value: string): boolean {
  return path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../");
}

function safeTelegramFileName(filePath: string): string {
  return path.basename(filePath).replace(/[^A-Za-z0-9._-]/g, "_") || "telegram-file";
}


function telegramPairCommand(update: TelegramUpdateLike): { code: string; userId: string; chatId: string; messageId: number } | undefined {
  const message = update.message;
  const text = message?.text?.trim();
  if (!message || !text) return undefined;
  const match = text.match(/^\/pair(?:@\w+)?\s+(\S+)$/i);
  if (!match || !match[1] || !message.from) return undefined;
  return { code: match[1], userId: String(message.from.id), chatId: String(message.chat.id), messageId: message.message_id };
}

function pairingMode(pairing: TelegramPairingOptions): "first-user" | "code" {
  return pairing.mode ?? (pairing.codeFactory ? "code" : "first-user");
}

function makeTelegramPairingCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

async function atomicWriteText(target: string, text: string, mode: number): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, text, { mode });
  await rename(temp, target);
}

function isInsidePath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function redactToken(token: string): string {
  return `present:${token.length}chars`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error(`Telegram webhook body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

export { OpenAITelegramAttachmentTranscriber, asSecretRef, readSecretRefValue } from "./transcription.js";
export type { OpenAIAudioTranscriptionClient, OpenAITelegramTranscriberOptions } from "./transcription.js";

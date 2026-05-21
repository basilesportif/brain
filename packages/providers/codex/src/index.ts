import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { EchoProviderSession, type ProviderAdapter, type ProviderHealth, type ProviderResumeHandle, type ProviderSession, type ProviderTurn, type ProviderTurnEvent } from "@brain/runtime-core";

export type CodexTransportKind = "app-server" | "exec" | "stub";

export interface CodexProviderOptions {
  /** Integration mode is intentionally behind this provider boundary. */
  transport?: CodexTransportKind;
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  appServerUrl?: string;
  binary?: string;
  cwd?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | (string & {});
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | (string & {});
  extraConfig?: string[];
  transportImpl?: CodexTransport;
  /** Full argv after binary for exec mode. Defaults to `codex exec --json ... -`. */
  execArgs?: string[];
  /** Keep Codex's own session files by default so provider resume remains possible. */
  ephemeral?: boolean;
  /** Resume a provider-native Codex exec session by id when sending turns. */
  resumeSessionId?: string;
  /** Resume the most recent provider-native Codex exec session when no explicit id is available. */
  resumeLast?: boolean;
  /** Capture Codex's last assistant message as a file in the turn artifact dir. */
  captureLastMessage?: boolean;
  lastMessageFilename?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  appServerStartupTimeoutMs?: number;
  appServerRequestTimeoutMs?: number;
  appServerServiceName?: string;
  appServerBaseInstructions?: string;
  appServerDeveloperInstructions?: string;
  appServerExperimentalRawEvents?: boolean;
  appServerPersistExtendedHistory?: boolean;
  appServerClient?: CodexAppServerClient;
  /** Test seam for the Codex app-server JSON-RPC WebSocket transport. */
  appServerWebSocketFactory?: CodexAppServerWebSocketFactory;
}

export type CodexSessionInput = Parameters<ProviderAdapter["createSession"]>[0];

export interface CodexTransport {
  readonly kind: CodexTransportKind;
  createSession(input: CodexSessionInput): Promise<ProviderSession>;
}

export interface CodexAppServerClient {
  createSession(input: CodexAppServerSessionInput): Promise<ProviderSession>;
}

export interface CodexAppServerSessionInput extends CodexSessionInput {
  id: string;
  options: CodexProviderOptions;
}

export type CodexJsonRpcMessage = Record<string, unknown> & {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export interface CodexAppServerWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "close", listener: (event?: unknown) => void, options?: { once?: boolean }): void;
  addEventListener(type: "error", listener: (event?: unknown) => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "open" | "close" | "error" | "message", listener: (...args: never[]) => void): void;
}

export type CodexAppServerWebSocketFactory = (url: string) => CodexAppServerWebSocket;

export class CodexProviderAdapter implements ProviderAdapter {
  readonly id = "codex";
  private readonly transport: CodexTransport;

  constructor(readonly options: CodexProviderOptions = {}) {
    this.transport = options.transportImpl ?? createCodexTransport(options);
  }

  async createSession(input: CodexSessionInput): Promise<ProviderSession> {
    return this.transport.createSession(input);
  }
}

export class CodexStubTransport implements CodexTransport {
  readonly kind = "stub" as const;

  constructor(private readonly options: CodexProviderOptions = {}) {}

  async createSession(input: CodexSessionInput): Promise<ProviderSession> {
    return new CodexStubSession(`codex_${input.workspaceId}`, this.options);
  }
}

export class CodexStubSession extends EchoProviderSession {
  override readonly provider = "codex";

  constructor(id: string, readonly options: CodexProviderOptions = {}) {
    super(id);
  }
}

export class CodexAppServerTransport implements CodexTransport {
  readonly kind = "app-server" as const;

  constructor(private readonly options: CodexProviderOptions = {}) {}

  async createSession(input: CodexSessionInput): Promise<ProviderSession> {
    const id = `codex_app_${input.workspaceId}`;
    if (this.options.appServerClient) return this.options.appServerClient.createSession({ ...input, id, options: this.options });
    return new CodexAppServerProtocolSession(id, input.workspaceId, this.options, input.metadata);
  }
}

export class CodexExecTransport implements CodexTransport {
  readonly kind = "exec" as const;

  constructor(private readonly options: CodexProviderOptions = {}) {}

  async createSession(input: CodexSessionInput): Promise<ProviderSession> {
    return new CodexExecSession(`codex_exec_${input.workspaceId}`, this.options, input.metadata);
  }
}

export class CodexAppServerProtocolSession implements ProviderSession {
  readonly provider = "codex";
  private started = false;
  private child?: ChildProcess;
  private ws?: CodexAppServerWebSocket;
  private connected = false;
  private requestId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notificationHandlers = new Set<(message: CodexJsonRpcMessage) => void>();
  private readonly activeTurnIds = new Map<string, string>();
  private currentThreadId?: string;
  private currentResumeHandle?: ProviderResumeHandle;
  private lastError?: Error;

  constructor(
    readonly id: string,
    readonly workspaceId: string,
    readonly options: CodexProviderOptions = {},
    readonly metadata?: CodexSessionInput["metadata"],
  ) {}

  async start(): Promise<void> {
    if (this.started && this.connected) return;
    this.started = true;
    const url = await this.resolveAppServerUrl();
    if (!url) return;
    if (this.options.binary && !this.options.appServerUrl) this.spawnAppServer(url);
    await this.connectWithRetry(url);
    await this.request("initialize", {
      clientInfo: { name: "brain", title: "Brain Codex provider", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.connected = false;
    this.rejectAll(new Error("Codex app-server session stopped"));
    this.ws?.close();
    this.ws = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  }

  async health(): Promise<ProviderHealth> {
    const hasConfig = Boolean(this.options.appServerUrl || this.options.binary);
    return {
      ok: this.connected && Boolean(this.ws),
      provider: this.provider,
      sessionId: this.id,
      detail: this.connected
        ? `connected${this.currentThreadId ? ` thread=${this.currentThreadId}` : ""}`
        : hasConfig
          ? (this.lastError?.message ?? "app-server configured but not connected")
          : "set appServerUrl or binary for Codex app-server transport",
    };
  }

  async resumeHandle(): Promise<ProviderResumeHandle | undefined> {
    return this.currentResumeHandle;
  }

  async cancelTurn(turnId: string, reason = "cancelled"): Promise<void> {
    const providerTurnId = this.activeTurnIds.get(turnId) ?? turnId;
    if (!this.connected) return;
    await this.request("turn/interrupt", { turnId: providerTurnId, reason }).catch(() => undefined);
  }

  async steerTurn(turnId: string, text: string): Promise<void> {
    const providerTurnId = this.activeTurnIds.get(turnId) ?? turnId;
    if (!this.connected) throw new Error("Codex app-server is not connected");
    await this.request("turn/steer", { turnId: providerTurnId, input: [{ type: "text", text, text_elements: [] }] });
  }

  async *sendTurn(turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    if (!this.started) await this.start();
    if (!this.connected) {
      yield { type: "error", message: "Codex app-server transport is not connected; use exec transport or configure appServerUrl/binary.", raw: this.safeOptions() };
      return;
    }

    const queue = new AsyncEventQueue<ProviderTurnEvent>();
    let providerTurnId = "";
    let accumulated = "";
    let sawFinal = false;
    const handler = (message: CodexJsonRpcMessage): void => {
      if (!message.method || typeof message.params !== "object" || message.params === null) return;
      const params = message.params as Record<string, unknown>;
      const resumeHandle = extractResumeHandle({ method: message.method, params }, this.provider);
      if (resumeHandle) {
        this.currentResumeHandle = resumeHandle;
        this.currentThreadId = resumeHandle.sessionId ?? this.currentThreadId;
      }
      if (message.method === "item/agentMessage/delta" && params.turnId === providerTurnId && typeof params.delta === "string") {
        accumulated += params.delta;
        queue.push({ type: "delta", text: params.delta });
        return;
      }
      if (message.method === "turn/completed" && typeof params.turn === "object" && params.turn !== null) {
        const turnRecord = params.turn as Record<string, unknown>;
        if (turnRecord.id === providerTurnId) {
          const text = extractFinalText({ params }) ?? accumulated;
          sawFinal = true;
          queue.push({ type: "final", text });
          queue.close();
        }
        return;
      }
      if (message.method === "error") {
        queue.push({ type: "error", message: extractErrorMessage({ params }) ?? JSON.stringify(params), raw: params });
      }
    };

    this.notificationHandlers.add(handler);
    queue.push({ type: "status", message: "starting Codex app-server turn", raw: { metadata: this.metadata, threadId: this.currentThreadId } });
    try {
      await this.ensureThread(turn);
      if (!this.currentThreadId) throw new Error("Codex app-server did not provide a thread id");
      const response = await this.request<Record<string, unknown>>("turn/start", this.turnStartParams(turn));
      const providerTurn = asRecord(response.turn);
      providerTurnId = stringValue(providerTurn.id) ?? "";
      if (!providerTurnId) throw new Error("Codex app-server did not return a turn id");
      this.activeTurnIds.set(turn.id, providerTurnId);
      const resumeHandle = extractResumeHandle({ method: "turn/start", params: { turn: providerTurn, threadId: this.currentThreadId } }, this.provider);
      if (resumeHandle) this.currentResumeHandle = resumeHandle;
      for await (const event of queue) yield event;
    } catch (error) {
      yield { type: "error", message: `Codex app-server turn failed: ${errorMessage(error)}`, raw: this.safeOptions() };
      if (!sawFinal) queue.close();
    } finally {
      this.notificationHandlers.delete(handler);
      this.activeTurnIds.delete(turn.id);
      queue.close();
    }
  }

  private safeOptions(): Record<string, unknown> {
    return {
      transport: "app-server",
      model: this.options.model,
      effort: this.options.effort,
      hasAppServerUrl: Boolean(this.options.appServerUrl),
      binary: this.options.binary,
      cwd: this.options.cwd,
      sandbox: this.options.sandbox,
      approvalPolicy: this.options.approvalPolicy,
      extraConfigCount: this.options.extraConfig?.length ?? 0,
      hasAppServerClient: Boolean(this.options.appServerClient),
      metadata: this.metadata,
    };
  }

  private async ensureThread(turn: ProviderTurn): Promise<void> {
    if (this.currentThreadId) return;
    const resumeSessionId = this.options.resumeSessionId ?? turn.resumeHandle?.sessionId ?? turn.resumeHandle?.handle ?? this.currentResumeHandle?.sessionId;
    if (resumeSessionId) {
      try {
        const response = await this.request<Record<string, unknown>>("thread/resume", this.threadParams(turn, { threadId: resumeSessionId }));
        this.recordThreadResponse(response, "thread/resume");
        return;
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    const response = await this.request<Record<string, unknown>>("thread/start", this.threadParams(turn));
    this.recordThreadResponse(response, "thread/start");
  }

  private recordThreadResponse(response: Record<string, unknown>, method: string): void {
    const thread = asRecord(response.thread);
    const threadId = stringValue(thread.id) ?? stringValue(response.threadId);
    if (!threadId) throw new Error(`Codex app-server ${method} did not return a thread id`);
    this.currentThreadId = threadId;
    this.currentResumeHandle = {
      provider: this.provider,
      sessionId: threadId,
      handle: threadId,
      metadata: compactMetadata({ source: "codex-app-server", eventType: method }),
    };
  }

  private threadParams(turn: ProviderTurn, resume?: { threadId: string }): Record<string, unknown> {
    return compactUnknown({
      threadId: resume?.threadId,
      model: this.options.model,
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandbox,
      config: this.threadConfig(),
      serviceName: this.options.appServerServiceName ?? `brain:${this.workspaceId}`,
      baseInstructions: this.options.appServerBaseInstructions,
      developerInstructions: this.options.appServerDeveloperInstructions ?? this.options.appServerBaseInstructions,
      ephemeral: this.options.ephemeral ?? false,
      experimentalRawEvents: this.options.appServerExperimentalRawEvents ?? false,
      persistExtendedHistory: this.options.appServerPersistExtendedHistory ?? !(this.options.ephemeral ?? false),
      metadata: compactUnknown({ runtimeSessionId: this.id, workspaceId: this.workspaceId, turnId: turn.id }),
    });
  }

  private turnStartParams(turn: ProviderTurn): Record<string, unknown> {
    return compactUnknown({
      threadId: this.currentThreadId,
      input: turnInputForAppServer(turn),
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      model: this.options.model,
      effort: this.options.effort,
    });
  }

  private threadConfig(): Record<string, unknown> {
    return compactUnknown({
      model_reasoning_effort: this.options.effort,
    });
  }

  private async resolveAppServerUrl(): Promise<string | undefined> {
    if (this.options.appServerUrl) return this.options.appServerUrl;
    if (!this.options.binary) return undefined;
    return `ws://127.0.0.1:${await getOpenPort()}`;
  }

  private spawnAppServer(listenUrl: string): void {
    const binary = this.options.binary ?? "codex";
    const args = ["app-server", "--listen", listenUrl];
    for (const item of this.options.extraConfig ?? []) args.push("-c", item);
    const { OPENAI_API_KEY: _omit, ...safeEnv } = process.env;
    const child = spawn(binary, args, { cwd: this.options.cwd, env: safeEnv, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.lastError = new Error(text.slice(-1_000));
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.connected = false;
      this.lastError = new Error(`Codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.rejectAll(this.lastError);
    });
  }

  private async connectWithRetry(url: string): Promise<void> {
    const deadline = Date.now() + (this.options.appServerStartupTimeoutMs ?? 10_000);
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        await this.connect(url);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    this.lastError = lastError instanceof Error ? lastError : new Error(String(lastError));
    throw this.lastError;
  }

  private async connect(url: string): Promise<void> {
    const ws = (this.options.appServerWebSocketFactory ?? defaultWebSocketFactory)(url);
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      this.handleMessage(webSocketMessageToString(event.data));
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.connected = false;
      const error = new Error("Codex app-server websocket closed");
      this.lastError = error;
      this.rejectAll(error);
    });
    ws.addEventListener("error", (event) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.lastError = event instanceof Error ? event : new Error("Codex app-server websocket error");
    });
    await waitForWebSocketOpen(ws, this.options.appServerStartupTimeoutMs ?? 10_000);
    this.connected = true;
  }

  private handleMessage(raw: string): void {
    let message: CodexJsonRpcMessage;
    try {
      message = JSON.parse(raw) as CodexJsonRpcMessage;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    for (const handler of this.notificationHandlers) handler(message);
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) throw new Error("Codex app-server is not connected");
    const id = this.requestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.options.appServerRequestTimeoutMs ?? this.options.timeoutMs ?? 600_000);
      this.pending.set(id, {
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws?.send(JSON.stringify({ id, method, params }));
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** @deprecated Use CodexAppServerProtocolSession for app-server or CodexExecSession for exec. */
export class CodexAppServerShellSession extends CodexAppServerProtocolSession {
  constructor(id: string, options: CodexProviderOptions = {}, metadata?: CodexSessionInput["metadata"]) {
    super(id, "default", options, metadata);
  }
}

/** @deprecated Use CodexAppServerProtocolSession for app-server or CodexExecSession for exec. */
export class CodexTransportShellSession extends CodexAppServerProtocolSession {
  constructor(id: string, readonly transportKind: Exclude<CodexTransportKind, "stub">, options: CodexProviderOptions = {}, metadata?: CodexSessionInput["metadata"]) {
    super(id, "default", options, metadata);
  }
}

export class CodexExecSession implements ProviderSession {
  readonly provider = "codex";
  private started = false;
  private readonly activeTurns = new Map<string, ChildProcess>();
  private currentResumeHandle?: ProviderResumeHandle;

  constructor(
    readonly id: string,
    readonly options: CodexProviderOptions = {},
    readonly metadata?: CodexSessionInput["metadata"],
  ) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const [turnId, child] of this.activeTurns) {
      child.kill("SIGTERM");
      this.activeTurns.delete(turnId);
    }
  }

  async resumeHandle(): Promise<ProviderResumeHandle | undefined> {
    return this.currentResumeHandle;
  }

  async cancelTurn(turnId: string, reason = "cancelled"): Promise<void> {
    const child = this.activeTurns.get(turnId);
    if (!child) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000).unref?.();
    void reason;
  }

  async health(): Promise<ProviderHealth> {
    const binary = this.options.binary ?? "codex";
    const result = await collectProcess(binary, ["--version"], {
      cwd: this.options.cwd,
      timeoutMs: Math.min(this.options.timeoutMs ?? 5_000, 10_000),
      maxOutputBytes: 32_000,
    });
    return {
      ok: result.exitCode === 0,
      provider: this.provider,
      sessionId: this.id,
      detail: result.exitCode === 0
        ? (result.stdout.trim() || `${binary} is executable`)
        : (result.error?.message ?? (result.stderr.trim() || `${binary} --version exited ${result.exitCode ?? "without a code"}`)),
    };
  }

  async *sendTurn(turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    if (!this.started) await this.start();
    const binary = this.options.binary ?? "codex";
    const invocation = await buildCodexExecInvocation(this.options, turn);
    const args = invocation.args;
    const queue = new AsyncEventQueue<ProviderTurnEvent>();
    const state: CodexExecEventState = { accumulatedText: "", sawFinal: false, provider: this.provider };
    let stdoutRemainder = "";
    let stdoutText = "";
    let stderrText = "";
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let outputLimited = false;
    const maxOutputBytes = this.options.maxOutputBytes ?? 4_000_000;

    queue.push({ type: "status", message: "starting Codex exec transport", raw: { binary, args: redactPromptArgs(args, turn.prompt), metadata: this.metadata, artifactDir: turn.artifactDir } });

    let child: ChildProcess;
    try {
      child = spawn(binary, args, { cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      queue.push({ type: "error", message: `Failed to spawn Codex exec transport: ${errorMessage(error)}`, raw: { binary, args: redactPromptArgs(args, turn.prompt) } });
      queue.close();
      yield* queue;
      return;
    }
    this.activeTurns.set(turn.id, child);

    const abortTurn = () => {
      if (cancelled) return;
      cancelled = true;
      queue.push({ type: "error", message: `Codex exec turn cancelled: ${String(turn.abortSignal?.reason ?? "cancelled")}` });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000).unref?.();
    };
    if (turn.abortSignal?.aborted) abortTurn();
    else turn.abortSignal?.addEventListener("abort", abortTurn, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      queue.push({ type: "error", message: `Codex exec transport timed out after ${this.options.timeoutMs ?? 600_000}ms` });
    }, this.options.timeoutMs ?? 600_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputLimited = true;
        child.kill("SIGTERM");
        queue.push({ type: "error", message: `Codex exec output exceeded maxOutputBytes (${maxOutputBytes})` });
        return;
      }
      const text = chunk.toString("utf8");
      stdoutText += text;
      const parsed = consumeJsonl(text, stdoutRemainder, (value) => {
        for (const event of codexJsonToProviderEvents(value, state)) queue.push(event);
      });
      stdoutRemainder = parsed.remainder;
      if (parsed.unparsedText) {
        state.accumulatedText += parsed.unparsedText;
        queue.push({ type: "delta", text: parsed.unparsedText });
      }
      if (state.resumeHandle) this.currentResumeHandle = state.resumeHandle;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrText += text;
      if (text.trim()) queue.push({ type: "status", message: text.trim() });
    });

    child.on("error", (error) => {
      queue.push({ type: "error", message: `Codex exec process error: ${errorMessage(error)}` });
    });

    child.on("close", (code, signal) => {
      void (async () => {
        clearTimeout(timeout);
        this.activeTurns.delete(turn.id);
        turn.abortSignal?.removeEventListener("abort", abortTurn);
        if (stdoutRemainder.trim()) {
          try {
            for (const event of codexJsonToProviderEvents(JSON.parse(stdoutRemainder), state)) queue.push(event);
          } catch {
            state.accumulatedText += stdoutRemainder;
            queue.push({ type: "delta", text: stdoutRemainder });
          }
        }
        if (state.resumeHandle) this.currentResumeHandle = state.resumeHandle;
        if (invocation.lastMessagePath) {
          const lastText = await readOptionalText(invocation.lastMessagePath);
          if (lastText && !state.sawFinal) {
            state.sawFinal = true;
            queue.push({ type: "final", text: lastText.trimEnd() });
          }
          queue.push({
            type: "artifact",
            artifact: {
              kind: "document",
              localPath: invocation.lastMessagePath,
              mimeType: "text/markdown",
              originalName: path.basename(invocation.lastMessagePath),
            },
          });
        }
        if (code && code !== 0 && !timedOut && !cancelled && !outputLimited) {
          queue.push({ type: "error", message: `Codex exec exited with code ${code}`, raw: { stderr: stderrText.trim(), stdout: stdoutText.trim().slice(-4_000), signal } });
        } else if (!state.sawFinal && !cancelled) {
          const text = state.accumulatedText.trim() || stdoutText.trim();
          if (text) queue.push({ type: "final", text });
          else if (!timedOut) queue.push({ type: "status", message: "Codex exec completed without assistant text" });
        }
        queue.close();
      })();
    });

    child.stdin?.end(turn.prompt);
    yield* queue;
  }
}

export function createCodexTransport(options: CodexProviderOptions = {}): CodexTransport {
  if (options.transport === "app-server") return new CodexAppServerTransport(options);
  if (options.transport === "exec") return new CodexExecTransport(options);
  return new CodexStubTransport(options);
}

export function createCodexProvider(options: CodexProviderOptions = {}): ProviderAdapter {
  return new CodexProviderAdapter(options);
}

function defaultWebSocketFactory(url: string): CodexAppServerWebSocket {
  return new WebSocket(url) as unknown as CodexAppServerWebSocket;
}

function waitForWebSocketOpen(ws: CodexAppServerWebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to Codex app-server after ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Codex app-server websocket error during connect"));
    }, { once: true });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error("Codex app-server websocket closed during connect"));
    }, { once: true });
  });
}

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("failed to allocate a local app-server port"));
      });
    });
  });
}

function turnInputForAppServer(turn: ProviderTurn): unknown[] {
  const input: unknown[] = [{ type: "text", text: turn.prompt, text_elements: [] }];
  for (const attachment of turn.attachments ?? []) {
    if (attachment.kind === "image" && attachment.localPath) input.push({ type: "localImage", path: attachment.localPath });
    else if (attachment.localPath) input.push({ type: "localFile", path: attachment.localPath, mimeType: attachment.mimeType, name: attachment.originalName });
  }
  return input;
}

function compactUnknown<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== "")) as T;
}

function webSocketMessageToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

export function buildCodexExecArgs(options: CodexProviderOptions, turn: ProviderTurn): string[] {
  return buildCodexExecInvocationSync(options, turn).args;
}

interface CodexExecInvocation {
  args: string[];
  lastMessagePath?: string;
}

async function buildCodexExecInvocation(options: CodexProviderOptions, turn: ProviderTurn): Promise<CodexExecInvocation> {
  const invocation = buildCodexExecInvocationSync(options, turn);
  if (invocation.lastMessagePath) await mkdir(path.dirname(invocation.lastMessagePath), { recursive: true, mode: 0o700 });
  return invocation;
}

function buildCodexExecInvocationSync(options: CodexProviderOptions, turn: ProviderTurn): CodexExecInvocation {
  if (options.execArgs) return { args: options.execArgs.map((arg) => arg === "{prompt}" ? turn.prompt : arg) };

  const resumeSessionId = options.resumeSessionId ?? turn.resumeHandle?.sessionId ?? turn.resumeHandle?.handle;
  const useResume = Boolean(options.resumeLast || resumeSessionId);
  const args = useResume ? ["exec", "resume", "--json"] : ["exec", "--json", "--color", "never"];
  if (options.model) args.push("--model", options.model);
  if (!useResume && options.cwd) args.push("--cd", options.cwd);
  if (!useResume && options.sandbox) args.push("--sandbox", options.sandbox);
  if (options.approvalPolicy) args.push("--config", `approval_policy=${JSON.stringify(options.approvalPolicy)}`);
  if (options.ephemeral) args.push("--ephemeral");
  for (const config of options.extraConfig ?? []) args.push("--config", config);
  if (options.effort) args.push("--config", `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  for (const attachment of turn.attachments ?? []) {
    if (attachment.kind === "image" && attachment.localPath) args.push("--image", attachment.localPath);
  }
  const lastMessagePath = lastMessagePathFor(options, turn);
  if (lastMessagePath) args.push("--output-last-message", lastMessagePath);
  if (useResume) {
    if (options.resumeLast && !resumeSessionId) args.push("--last");
    else if (resumeSessionId) args.push(resumeSessionId);
  }
  args.push("-");
  return { args, lastMessagePath };
}

function lastMessagePathFor(options: CodexProviderOptions, turn: ProviderTurn): string | undefined {
  if (options.captureLastMessage === false) return undefined;
  const artifactDir = turn.artifactDir;
  if (!artifactDir) return undefined;
  return path.join(artifactDir, options.lastMessageFilename ?? "codex-last-message.md");
}

interface CodexExecEventState {
  accumulatedText: string;
  sawFinal: boolean;
  provider: string;
  resumeHandle?: ProviderResumeHandle;
}

function codexJsonToProviderEvents(value: unknown, state: CodexExecEventState): ProviderTurnEvent[] {
  const record = asRecord(value);
  const params = asRecord(record.params);
  const type = stringValue(record.type) ?? stringValue(record.event) ?? stringValue(record.method) ?? stringValue(asRecord(record.msg).type);
  const normalized = type?.replaceAll("_", "/").toLowerCase();
  const resumeHandle = extractResumeHandle(record, state.provider);
  if (resumeHandle) state.resumeHandle = resumeHandle;
  const delta = stringValue(record.delta) ?? stringValue(params.delta) ?? stringValue(record.text_delta);
  if (delta && (normalized?.includes("delta") ?? true)) {
    state.accumulatedText += delta;
    return [{ type: "delta", text: delta }];
  }

  if (normalized?.includes("agentmessage") && stringValue(params.text)) {
    const text = stringValue(params.text) ?? "";
    state.accumulatedText += text;
    return [{ type: "delta", text }];
  }

  if (normalized?.includes("error")) {
    return [{ type: "error", message: extractErrorMessage(record) ?? "Codex reported an error", raw: value }];
  }

  if (normalized?.includes("turn/completed") || normalized?.includes("final") || normalized?.includes("completed")) {
    const text = extractFinalText(record) ?? state.accumulatedText.trim();
    if (text) {
      state.sawFinal = true;
      return [{ type: "final", text }];
    }
    return [{ type: "status", message: "Codex turn completed", raw: value }];
  }

  if (normalized?.includes("turn/started") || normalized?.includes("thread/started") || normalized?.includes("status")) {
    return [{
      type: "status",
      message: type ?? "Codex status",
      raw: resumeHandle ? { event: value, resumeHandle } : value,
    }];
  }

  return [];
}

function extractResumeHandle(record: Record<string, unknown>, provider: string): ProviderResumeHandle | undefined {
  const params = asRecord(record.params);
  const thread = asRecord(params.thread);
  const turn = asRecord(params.turn);
  const sessionId = stringValue(record.session_id)
    ?? stringValue(record.sessionId)
    ?? stringValue(record.conversation_id)
    ?? stringValue(record.conversationId)
    ?? stringValue(params.session_id)
    ?? stringValue(params.sessionId)
    ?? stringValue(params.conversation_id)
    ?? stringValue(params.conversationId)
    ?? stringValue(params.threadId)
    ?? stringValue(thread.id)
    ?? stringValue(thread.threadId)
    ?? stringValue(thread.conversationId)
    ?? stringValue(turn.threadId);
  const turnId = stringValue(record.turn_id)
    ?? stringValue(record.turnId)
    ?? stringValue(params.turn_id)
    ?? stringValue(params.turnId)
    ?? stringValue(turn.id)
    ?? stringValue(turn.turnId);
  if (!sessionId && !turnId) return undefined;
  return {
    provider,
    sessionId,
    turnId,
    handle: sessionId,
    metadata: compactMetadata({
      source: "codex-jsonl",
      eventType: stringValue(record.type) ?? stringValue(record.event) ?? stringValue(record.method),
    }),
  };
}

function extractFinalText(record: Record<string, unknown>): string | undefined {
  const direct = stringValue(record.final) ?? stringValue(record.text) ?? stringValue(record.message);
  if (direct) return direct;
  const params = asRecord(record.params);
  const paramsText = stringValue(params.final) ?? stringValue(params.text) ?? stringValue(params.message);
  if (paramsText) return paramsText;
  const turn = asRecord(params.turn);
  const items = Array.isArray(turn.items) ? turn.items : undefined;
  const itemTexts = items?.flatMap((item) => extractItemText(item)).filter(Boolean) ?? [];
  return itemTexts.length ? itemTexts.join("\n") : undefined;
}

function extractItemText(item: unknown): string[] {
  const record = asRecord(item);
  if (record.type === "agentMessage" && stringValue(record.text)) return [stringValue(record.text) ?? ""];
  if (record.type === "reasoning") return [];
  const content = Array.isArray(record.content) ? record.content : [];
  return content.map((entry) => stringValue(asRecord(entry).text)).filter((text): text is string => Boolean(text));
}

function extractErrorMessage(record: Record<string, unknown>): string | undefined {
  const error = optionalRecord(record.error) ?? optionalRecord(asRecord(record.params).error) ?? {};
  return stringValue(record.message) ?? stringValue(error.message) ?? stringValue(error.detail);
}

function consumeJsonl(text: string, previousRemainder: string, onJson: (value: unknown) => void): { remainder: string; unparsedText: string } {
  const combined = previousRemainder + text;
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  let unparsedText = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      onJson(JSON.parse(line));
    } catch {
      unparsedText += `${line}\n`;
    }
  }
  return { remainder, unparsedText };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactMetadata(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => typeof value === "string" && value.length > 0)) as Record<string, string>;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function redactPromptArgs(args: string[], prompt: string): string[] {
  return args.map((arg) => {
    if (arg === prompt) return "[prompt]";
    return arg.length > 200 ? `${arg.slice(0, 80)}…${arg.slice(-20)}` : arg;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CollectProcessOptions {
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface CollectProcessResult {
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function collectProcess(binary: string, args: string[], options: CollectProcessOptions): Promise<CollectProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ stdout, stderr, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      resolve({ stdout, stderr, error: new Error(`timed out after ${options.timeoutMs}ms`) });
    }, options.timeoutMs);
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-options.maxOutputBytes);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, error });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.values.length) yield this.values.shift() as T;
      else if (this.closed) return;
      else {
        const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }
}

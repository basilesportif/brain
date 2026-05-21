import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
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
  appServerClient?: CodexAppServerClient;
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
    return new CodexAppServerShellSession(id, this.options, input.metadata);
  }
}

export class CodexExecTransport implements CodexTransport {
  readonly kind = "exec" as const;

  constructor(private readonly options: CodexProviderOptions = {}) {}

  async createSession(input: CodexSessionInput): Promise<ProviderSession> {
    return new CodexExecSession(`codex_exec_${input.workspaceId}`, this.options, input.metadata);
  }
}

export class CodexAppServerShellSession implements ProviderSession {
  readonly provider = "codex";
  private started = false;

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
  }

  async health(): Promise<ProviderHealth> {
    return {
      ok: false,
      provider: this.provider,
      sessionId: this.id,
      detail: this.options.appServerUrl || this.options.binary
        ? "app-server configuration is present, but no Codex app-server protocol client is attached"
        : "set appServerUrl/binary and attach an appServerClient when wiring Codex app-server transport",
    };
  }

  async *sendTurn(_turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    if (!this.started) await this.start();
    yield {
      type: "error",
      message: "Codex app-server transport needs a protocol client before turns can be sent. Use exec transport or inject appServerClient.",
      raw: this.safeOptions(),
    };
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
}

/** @deprecated Use CodexAppServerShellSession for app-server or CodexExecSession for exec. */
export class CodexTransportShellSession extends CodexAppServerShellSession {
  constructor(id: string, readonly transportKind: Exclude<CodexTransportKind, "stub">, options: CodexProviderOptions = {}, metadata?: CodexSessionInput["metadata"]) {
    super(id, options, metadata);
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

import { EchoProviderSession, type ProviderAdapter, type ProviderHealth, type ProviderSession, type ProviderTurn, type ProviderTurnEvent } from "@brain/runtime-core";

export type ClaudeCodeTransportKind = "sdk" | "subagent" | "stub";

export interface ClaudeCodeProviderOptions {
  transport?: ClaudeCodeTransportKind;
  model?: string;
  sdkClient?: ClaudeCodeSdkClient;
  subagentClient?: ClaudeCodeSubagentClient;
}

export type ClaudeCodeSessionInput = Parameters<ProviderAdapter["createSession"]>[0];

export interface ClaudeCodeTransport {
  readonly kind: ClaudeCodeTransportKind;
  createSession(input: ClaudeCodeSessionInput): Promise<ProviderSession>;
}

export interface ClaudeCodeSdkClient {
  createSession(input: ClaudeCodeSdkSessionInput): Promise<ProviderSession>;
}

export interface ClaudeCodeSubagentClient {
  start(input: ClaudeCodeSubagentStartInput): Promise<ClaudeCodeSubagentRun>;
}

export interface ClaudeCodeSdkSessionInput extends ClaudeCodeSessionInput {
  id: string;
  options: ClaudeCodeProviderOptions;
}

export interface ClaudeCodeSubagentStartInput {
  id: string;
  workspaceId: string;
  turn: ProviderTurn;
  options: ClaudeCodeProviderOptions;
}

export interface ClaudeCodeSubagentRun {
  events: AsyncIterable<ProviderTurnEvent>;
  cancel?(reason?: string): Promise<void>;
  steer?(text: string): Promise<void>;
}

export class ClaudeCodeProviderAdapter implements ProviderAdapter {
  readonly id = "claude-code";
  private readonly transport: ClaudeCodeTransport;

  constructor(readonly options: ClaudeCodeProviderOptions = {}) {
    this.transport = createClaudeCodeTransport(options);
  }

  async createSession(input: ClaudeCodeSessionInput): Promise<ProviderSession> {
    return this.transport.createSession(input);
  }
}

export class ClaudeCodeStubTransport implements ClaudeCodeTransport {
  readonly kind = "stub" as const;

  constructor(private readonly options: ClaudeCodeProviderOptions = {}) {}

  async createSession(input: ClaudeCodeSessionInput): Promise<ProviderSession> {
    return new ClaudeCodeStubSession(`claude_${input.workspaceId}`, this.options);
  }
}

export class ClaudeCodeStubSession extends EchoProviderSession {
  override readonly provider = "claude-code";

  constructor(id: string, readonly options: ClaudeCodeProviderOptions = {}) {
    super(id);
  }
}

export class ClaudeCodeSdkTransport implements ClaudeCodeTransport {
  readonly kind = "sdk" as const;

  constructor(private readonly options: ClaudeCodeProviderOptions = {}) {}

  async createSession(input: ClaudeCodeSessionInput): Promise<ProviderSession> {
    const id = `claude_sdk_${input.workspaceId}`;
    if (this.options.sdkClient) return this.options.sdkClient.createSession({ ...input, id, options: this.options });
    return new ClaudeCodeMissingClientSession(id, "sdk", this.options);
  }
}

export class ClaudeCodeSubagentTransport implements ClaudeCodeTransport {
  readonly kind = "subagent" as const;

  constructor(private readonly options: ClaudeCodeProviderOptions = {}) {}

  async createSession(input: ClaudeCodeSessionInput): Promise<ProviderSession> {
    return new ClaudeCodeSubagentSession(`claude_subagent_${input.workspaceId}`, input.workspaceId, this.options);
  }
}

export class ClaudeCodeMissingClientSession implements ProviderSession {
  readonly provider = "claude-code";
  private started = false;

  constructor(readonly id: string, readonly transportKind: Exclude<ClaudeCodeTransportKind, "stub">, readonly options: ClaudeCodeProviderOptions = {}) {}

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
      detail: `Claude Code ${this.transportKind} transport requires an injected client; no SDK/subagent dependency is bundled in runtime-core.`,
    };
  }

  async *sendTurn(_turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    if (!this.started) await this.start();
    yield {
      type: "error",
      message: `Claude Code ${this.transportKind} transport is configured but no client implementation is attached.`,
      raw: { transport: this.transportKind, model: this.options.model },
    };
  }
}

export class ClaudeCodeSubagentSession implements ProviderSession {
  readonly provider = "claude-code";
  private started = false;
  private activeRun?: ClaudeCodeSubagentRun;

  constructor(readonly id: string, readonly workspaceId: string, readonly options: ClaudeCodeProviderOptions = {}) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.activeRun?.cancel?.("session stopped").catch(() => undefined);
    this.activeRun = undefined;
    this.started = false;
  }

  async health(): Promise<ProviderHealth> {
    return {
      ok: Boolean(this.options.subagentClient),
      provider: this.provider,
      sessionId: this.id,
      detail: this.options.subagentClient ? "Claude Code subagent client attached" : "Claude Code subagent transport requires an injected subagent client",
    };
  }

  async cancelTurn(_turnId: string, reason?: string): Promise<void> {
    await this.activeRun?.cancel?.(reason);
  }

  async steerTurn(_turnId: string, text: string): Promise<void> {
    if (!this.activeRun?.steer) throw new Error("Claude Code subagent run is not steerable");
    await this.activeRun.steer(text);
  }

  async *sendTurn(turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    if (!this.started) await this.start();
    if (!this.options.subagentClient) {
      yield {
        type: "error",
        message: "Claude Code subagent transport requires an injected subagent client.",
        raw: { transport: "subagent", model: this.options.model },
      };
      return;
    }
    const run = await this.options.subagentClient.start({ id: this.id, workspaceId: this.workspaceId, turn, options: this.options });
    this.activeRun = run;
    try {
      for await (const event of run.events) yield event;
    } finally {
      this.activeRun = undefined;
    }
  }
}

export function createClaudeCodeTransport(options: ClaudeCodeProviderOptions = {}): ClaudeCodeTransport {
  if (options.transport === "sdk") return new ClaudeCodeSdkTransport(options);
  if (options.transport === "subagent") return new ClaudeCodeSubagentTransport(options);
  return new ClaudeCodeStubTransport(options);
}

export function createClaudeCodeProvider(options: ClaudeCodeProviderOptions = {}): ProviderAdapter {
  return new ClaudeCodeProviderAdapter(options);
}

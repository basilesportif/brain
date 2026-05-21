import type { BrainAttachment, BrainOutboundAction, EntryPointInboundEvent, JsonRecord } from "@brain/entrypoint-protocol";

export interface ProviderResumeHandle {
  provider: string;
  sessionId?: string;
  turnId?: string;
  handle?: string;
  createdAt?: string;
  metadata?: JsonRecord;
}

export interface ProviderTurn {
  id: string;
  sessionId: string;
  inboundEvent: EntryPointInboundEvent;
  prompt: string;
  attachments?: BrainAttachment[];
  artifactDir?: string;
  abortSignal?: AbortSignal;
  resumeHandle?: ProviderResumeHandle;
  metadata?: JsonRecord;
}

export type ProviderTurnEvent =
  | { type: "delta"; text: string }
  | { type: "action"; action: BrainOutboundAction }
  | { type: "artifact"; artifact: BrainAttachment }
  | { type: "status"; message: string; raw?: unknown }
  | { type: "final"; text: string }
  | { type: "error"; message: string; raw?: unknown };

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  detail?: string;
  sessionId?: string;
}

export interface ProviderSession {
  id: string;
  provider: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ProviderHealth>;
  resumeHandle?(): Promise<ProviderResumeHandle | undefined>;
  cancelTurn?(turnId: string, reason?: string): Promise<void>;
  steerTurn?(turnId: string, text: string): Promise<void>;
  sendTurn(turn: ProviderTurn): AsyncIterable<ProviderTurnEvent>;
}

export interface ProviderAdapter {
  readonly id: string;
  createSession(options: { workspaceId: string; metadata?: JsonRecord }): Promise<ProviderSession>;
}

export class EchoProviderSession implements ProviderSession {
  readonly provider: string = "echo";
  private started = false;

  constructor(readonly id: string) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async health(): Promise<ProviderHealth> {
    return { ok: this.started, provider: this.provider, sessionId: this.id, detail: this.started ? "started" : "stopped" };
  }

  async *sendTurn(turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    if (!this.started) await this.start();
    const text = turn.inboundEvent.text?.trim() || turn.prompt.trim() || "(empty turn)";
    yield { type: "status", message: "echo provider received turn" };
    yield { type: "final", text: `Echo: ${text}` };
  }
}

export class EchoProviderAdapter implements ProviderAdapter {
  readonly id = "echo";

  async createSession(options: { workspaceId: string }): Promise<ProviderSession> {
    return new EchoProviderSession(`echo_${options.workspaceId}`);
  }
}

export type FakeProviderScript =
  | Iterable<ProviderTurnEvent>
  | AsyncIterable<ProviderTurnEvent>
  | ((turn: ProviderTurn) => Iterable<ProviderTurnEvent> | AsyncIterable<ProviderTurnEvent>);

export class FakeProviderSession implements ProviderSession {
  readonly provider: string = "fake";
  private started = false;

  constructor(readonly id: string, private readonly script: FakeProviderScript = defaultFakeProviderScript) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async health(): Promise<ProviderHealth> {
    return { ok: this.started, provider: this.provider, sessionId: this.id, detail: this.started ? "started" : "stopped" };
  }

  async *sendTurn(turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    if (!this.started) await this.start();
    const events = typeof this.script === "function" ? this.script(turn) : this.script;
    for await (const event of events) yield event;
  }
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id = "fake";

  constructor(private readonly script: FakeProviderScript = defaultFakeProviderScript) {}

  async createSession(options: { workspaceId: string }): Promise<ProviderSession> {
    return new FakeProviderSession(`fake_${options.workspaceId}`, this.script);
  }
}

function* defaultFakeProviderScript(turn: ProviderTurn): Iterable<ProviderTurnEvent> {
  const text = turn.inboundEvent.text?.trim() || turn.prompt.trim() || "(empty turn)";
  yield { type: "status", message: "fake provider received turn" };
  yield { type: "final", text: `Fake: ${text}` };
}

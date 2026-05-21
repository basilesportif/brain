import type { BrainAttachment, BrainOutboundAction, EntryPointInboundEvent, JsonRecord } from "@brain/entrypoint-protocol";

export interface ProviderTurn {
  id: string;
  sessionId: string;
  inboundEvent: EntryPointInboundEvent;
  prompt: string;
  attachments?: BrainAttachment[];
  metadata?: JsonRecord;
}

export type ProviderTurnEvent =
  | { type: "delta"; text: string }
  | { type: "action"; action: BrainOutboundAction }
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

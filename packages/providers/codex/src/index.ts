import { EchoProviderSession, type ProviderAdapter, type ProviderHealth, type ProviderSession, type ProviderTurn, type ProviderTurnEvent } from "@brain/runtime-core";

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
}

export type CodexSessionInput = Parameters<ProviderAdapter["createSession"]>[0];

export interface CodexTransport {
  readonly kind: CodexTransportKind;
  createSession(input: CodexSessionInput): Promise<ProviderSession>;
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
    return new CodexTransportShellSession(`codex_app_${input.workspaceId}`, this.kind, this.options, input.metadata);
  }
}

export class CodexExecTransport implements CodexTransport {
  readonly kind = "exec" as const;

  constructor(private readonly options: CodexProviderOptions = {}) {}

  async createSession(input: CodexSessionInput): Promise<ProviderSession> {
    return new CodexTransportShellSession(`codex_exec_${input.workspaceId}`, this.kind, this.options, input.metadata);
  }
}

export class CodexTransportShellSession implements ProviderSession {
  readonly provider = "codex";
  private started = false;

  constructor(
    readonly id: string,
    readonly transportKind: Exclude<CodexTransportKind, "stub">,
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
      detail: `${this.transportKind} transport boundary is typed but not implemented; ${this.requiredConfigurationHint()}`,
    };
  }

  async *sendTurn(_turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    if (!this.started) await this.start();
    yield {
      type: "error",
      message: `Codex ${this.transportKind} transport is not implemented yet. The provider boundary is ready for app-server/exec wiring behind @brain/provider-codex.`,
      raw: this.safeOptions(),
    };
  }

  private requiredConfigurationHint(): string {
    if (this.transportKind === "app-server") return this.options.appServerUrl || this.options.binary ? "configuration present" : "set appServerUrl or binary when wiring transport";
    return this.options.binary ? "configuration present" : "set binary when wiring exec transport";
  }

  private safeOptions(): Record<string, unknown> {
    return {
      transport: this.transportKind,
      model: this.options.model,
      effort: this.options.effort,
      hasAppServerUrl: Boolean(this.options.appServerUrl),
      binary: this.options.binary,
      cwd: this.options.cwd,
      sandbox: this.options.sandbox,
      approvalPolicy: this.options.approvalPolicy,
      extraConfigCount: this.options.extraConfig?.length ?? 0,
      metadata: this.metadata,
    };
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

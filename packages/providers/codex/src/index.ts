import { EchoProviderSession, type ProviderAdapter, type ProviderSession } from "@brain/runtime-core";

export interface CodexProviderOptions {
  /** Integration mode is intentionally behind this provider boundary. */
  transport?: "app-server" | "exec" | "stub";
  model?: string;
  appServerUrl?: string;
}

export class CodexProviderAdapter implements ProviderAdapter {
  readonly id = "codex";

  constructor(readonly options: CodexProviderOptions = {}) {}

  async createSession(input: { workspaceId: string }): Promise<ProviderSession> {
    // Initial foundation: expose the runtime-core contract without importing or
    // copying codex-chat app-server internals yet. Real Codex transport will be
    // swapped in behind this class.
    return new CodexStubSession(`codex_${input.workspaceId}`, this.options);
  }
}

export class CodexStubSession extends EchoProviderSession {
  override readonly provider = "codex";

  constructor(id: string, readonly options: CodexProviderOptions = {}) {
    super(id);
  }
}

export function createCodexProvider(options: CodexProviderOptions = {}): ProviderAdapter {
  return new CodexProviderAdapter(options);
}

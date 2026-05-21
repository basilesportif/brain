import { EchoProviderSession, type ProviderAdapter, type ProviderSession } from "@brain/runtime-core";

export interface ClaudeCodeProviderOptions {
  transport?: "sdk" | "subagent" | "stub";
  model?: string;
}

export class ClaudeCodeProviderAdapter implements ProviderAdapter {
  readonly id = "claude-code";

  constructor(readonly options: ClaudeCodeProviderOptions = {}) {}

  async createSession(input: { workspaceId: string }): Promise<ProviderSession> {
    // Initial foundation: keep Claude Code SDK/subagent details behind this
    // provider adapter until the real transport is ported.
    return new ClaudeCodeStubSession(`claude_${input.workspaceId}`, this.options);
  }
}

export class ClaudeCodeStubSession extends EchoProviderSession {
  override readonly provider = "claude-code";

  constructor(id: string, readonly options: ClaudeCodeProviderOptions = {}) {
    super(id);
  }
}

export function createClaudeCodeProvider(options: ClaudeCodeProviderOptions = {}): ProviderAdapter {
  return new ClaudeCodeProviderAdapter(options);
}

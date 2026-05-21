import { routeOutboundToOrigin, type BrainOutboundAction, type EntryPointInboundEvent } from "@brain/entrypoint-protocol";
import type { WorkspaceConfig } from "@brain/workspace-schema";
import { parseBrainDirectives } from "./directives.js";
import type { ProviderAdapter, ProviderSession, ProviderTurnEvent } from "./provider.js";

export interface RuntimeTurnResult {
  eventId: string;
  cleanText: string;
  finalText?: string;
  actions: BrainOutboundAction[];
  providerEvents: ProviderTurnEvent[];
  directiveErrors: string[];
}

export interface BrainRuntimeOptions {
  workspaceId: string;
  workspace: WorkspaceConfig;
  provider: ProviderAdapter;
}

export class BrainRuntime {
  private session?: ProviderSession;

  constructor(private readonly options: BrainRuntimeOptions) {}

  async start(): Promise<void> {
    this.session = await this.options.provider.createSession({ workspaceId: this.options.workspaceId });
    await this.session.start();
  }

  async stop(): Promise<void> {
    await this.session?.stop();
    this.session = undefined;
  }

  async handleInboundEvent(event: EntryPointInboundEvent): Promise<RuntimeTurnResult> {
    if (event.workspaceId !== this.options.workspaceId) {
      throw new Error(`Inbound event workspace mismatch: ${event.workspaceId} !== ${this.options.workspaceId}`);
    }
    if (!this.session) await this.start();
    const session = this.session;
    if (!session) throw new Error("Provider session failed to start");

    const providerEvents: ProviderTurnEvent[] = [];
    const actions: BrainOutboundAction[] = [];
    let finalText: string | undefined;
    for await (const providerEvent of session.sendTurn({
      id: `turn_${event.id}`,
      sessionId: session.id,
      inboundEvent: event,
      prompt: buildPrompt(event, this.options.workspace),
      attachments: event.attachments,
    })) {
      providerEvents.push(providerEvent);
      if (providerEvent.type === "action") actions.push(routeOutboundToOrigin(event, providerEvent.action));
      if (providerEvent.type === "final") finalText = providerEvent.text;
    }

    const parsed = parseBrainDirectives(finalText ?? "");
    for (const block of parsed.blocks) {
      for (const action of block.actions) actions.push(routeOutboundToOrigin(event, action));
    }
    if (parsed.cleanText) {
      actions.unshift(routeOutboundToOrigin(event, { type: "send_text", text: parsed.cleanText, format: "markdown" }));
    }

    return {
      eventId: event.id,
      cleanText: parsed.cleanText,
      finalText,
      actions,
      providerEvents,
      directiveErrors: parsed.errors,
    };
  }
}

export function buildPrompt(event: EntryPointInboundEvent, workspace: WorkspaceConfig): string {
  const entrypoint = workspace.enabledEntrypoints[event.entrypoint.entrypointId];
  const activeMetadata = {
    workspaceId: event.workspaceId,
    activeEntrypoint: {
      entrypointId: event.entrypoint.entrypointId,
      channelKind: event.entrypoint.channelKind,
      displayName: entrypoint?.displayName ?? event.entrypoint.displayName,
      capabilities: entrypoint?.capabilities ?? event.entrypoint.capabilities ?? {},
    },
    outboundDefaults: workspace.outboundDefaults ?? { route: "originating-entrypoint" },
  };
  return [
    "You are Brain, a provider-neutral assistant runtime.",
    "Use generic entrypoint, inbound event, outbound action, and artifact language.",
    "Do not expose channel secrets or raw adapter credentials.",
    `Active runtime context: ${JSON.stringify(activeMetadata)}`,
    event.text ? `Inbound text: ${event.text}` : "Inbound text: (none)",
  ].join("\n");
}

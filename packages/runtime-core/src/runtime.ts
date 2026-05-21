import { routeOutboundToOrigin, type BrainOutboundAction, type EntryPointInboundEvent } from "@brain/entrypoint-protocol";
import type { WorkspaceConfig } from "@brain/workspace-schema";
import { parseBrainDirectives } from "./directives.js";
import type { ProviderAdapter, ProviderSession, ProviderTurnEvent } from "./provider.js";
import type { SubagentDispatchPort } from "./subagents.js";

export interface RuntimeTurnResult {
  eventId: string;
  cleanText: string;
  finalText?: string;
  actions: BrainOutboundAction[];
  subagentJobIds: string[];
  providerEvents: ProviderTurnEvent[];
  directiveErrors: string[];
}

export interface BrainRuntimeOptions {
  workspaceId: string;
  workspace: WorkspaceConfig;
  provider: ProviderAdapter;
  subagents?: SubagentDispatchPort;
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
    const subagentJobIds: string[] = [];
    let finalText: string | undefined;
    for await (const providerEvent of session.sendTurn({
      id: `turn_${event.id}`,
      sessionId: session.id,
      inboundEvent: event,
      prompt: buildPrompt(event, this.options.workspace),
      attachments: event.attachments,
    })) {
      providerEvents.push(providerEvent);
      if (providerEvent.type === "action") await this.collectRuntimeAction(event, providerEvent.action, actions, subagentJobIds);
      if (providerEvent.type === "final") finalText = providerEvent.text;
    }

    const parsed = parseBrainDirectives(finalText ?? "");
    for (const block of parsed.blocks) {
      for (const action of block.actions) await this.collectRuntimeAction(event, action, actions, subagentJobIds);
    }
    if (parsed.cleanText) {
      actions.unshift(routeOutboundToOrigin(event, { type: "send_text", text: parsed.cleanText, format: "markdown" }));
    }

    return {
      eventId: event.id,
      cleanText: parsed.cleanText,
      finalText,
      actions,
      subagentJobIds,
      providerEvents,
      directiveErrors: parsed.errors,
    };
  }

  private async collectRuntimeAction(event: EntryPointInboundEvent, action: BrainOutboundAction, actions: BrainOutboundAction[], subagentJobIds: string[]): Promise<void> {
    const routed = routeOutboundToOrigin(event, action);
    if (routed.type === "dispatch_subagent" && this.options.subagents) {
      subagentJobIds.push(await this.options.subagents.dispatch({
        workspaceId: routed.workspaceId ?? event.workspaceId,
        profile: routed.profile,
        prompt: routed.prompt,
        route: routed.route ?? "return_to_main",
        ownerType: "main",
        ownerRequestId: routed.idempotencyKey ?? routed.id,
        parentTurnId: `turn_${event.id}`,
        timeoutSec: routed.timeoutSec,
        model: routed.model,
        effort: routed.effort,
        summary: routed.summary,
        images: routed.images,
        metadata: {
          originatingEventId: routed.originatingEventId ?? event.id,
          actionId: routed.id ?? routed.idempotencyKey ?? "",
        },
      }));
      return;
    }
    actions.push(routed);
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

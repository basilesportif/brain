import type { BrainEntrypointAdapter, EntryPointInboundEvent, OutboundDispatchResult } from "@brain/entrypoint-protocol";
import type { BrainRuntime, RuntimeTurnResult } from "./runtime.js";

export interface RuntimeEntrypointTurnResult {
  event: EntryPointInboundEvent;
  turn: RuntimeTurnResult;
  dispatchResults: OutboundDispatchResult[];
}

export interface RuntimeEntrypointRunOptions {
  maxEvents?: number;
  signal?: AbortSignal;
}

export interface RuntimeEntrypointRunResult {
  processed: RuntimeEntrypointTurnResult[];
  stoppedReason: "entrypoint-closed" | "max-events" | "aborted";
}

export interface RuntimeEntrypointBridgeOptions {
  runtime: BrainRuntime;
  entrypoint: BrainEntrypointAdapter;
}

export class RuntimeEntrypointBridge {
  constructor(private readonly options: RuntimeEntrypointBridgeOptions) {}

  async start(): Promise<void> {
    await this.options.entrypoint.start?.();
    await this.options.runtime.start();
  }

  async stop(): Promise<void> {
    await this.options.runtime.stop();
    await this.options.entrypoint.stop?.();
  }

  async handleEvent(event: EntryPointInboundEvent): Promise<RuntimeEntrypointTurnResult> {
    const turn = await this.options.runtime.handleInboundEvent(event);
    const dispatchResults: OutboundDispatchResult[] = [];
    for (const action of turn.actions) dispatchResults.push(await this.options.entrypoint.dispatch(action));
    return { event, turn, dispatchResults };
  }

  async run(options: RuntimeEntrypointRunOptions = {}): Promise<RuntimeEntrypointRunResult> {
    const processed: RuntimeEntrypointTurnResult[] = [];
    await this.start();

    for await (const event of this.options.entrypoint.inboundEvents()) {
      if (options.signal?.aborted) return { processed, stoppedReason: "aborted" };
      processed.push(await this.handleEvent(event));
      if (options.maxEvents !== undefined && processed.length >= options.maxEvents) {
        return { processed, stoppedReason: "max-events" };
      }
    }

    return {
      processed,
      stoppedReason: options.signal?.aborted ? "aborted" : "entrypoint-closed",
    };
  }
}

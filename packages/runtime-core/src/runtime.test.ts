import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { BrainRuntime, EchoProviderAdapter, FakeProviderAdapter, InMemorySubagentJobStore, RuntimeEntrypointBridge, StaticSubagentExecutor, SubagentLifecycle, buildPrompt, type ProviderAdapter, type ProviderSession, type ProviderTurn, type ProviderTurnEvent, type ProviderHealth } from "./index.js";

test("BrainRuntime turns provider final text into origin-routed outbound action", async () => {
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new EchoProviderAdapter(),
  });
  const result = await runtime.handleInboundEvent({
    id: "evt_1",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "hello",
    receivedAt: "2026-05-21T00:00:00.000Z",
  });
  assert.equal(result.actions[0]?.type, "send_text");
  assert.equal(result.actions[0]?.target?.entrypointId, "telegram-main");
  assert.match(result.cleanText, /Echo: hello/);
  assert.deepEqual(result.subagentJobIds, []);
});

test("buildPrompt exposes control-plane boundaries without making Brain production domain logic", () => {
  const prompt = buildPrompt({
    id: "evt_projects",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "do I have projects?",
    receivedAt: "2026-05-21T00:00:00.000Z",
  }, {
    workspacePath: "/home/brain/.brain/workspace",
    primaryEntrypointId: "telegram-main",
    enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
    outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
    promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
  });

  assert.match(prompt, /lab-only provider-neutral runtime seam/);
  assert.match(prompt, /Production live assistant traffic must run through codex-chat\.service/);
  assert.match(prompt, /separate assistant-agent-logic checkout and assistant-agent-data\/workspace/);
  assert.match(prompt, /Do not treat Brain's in-repo lab compatibility commands/);
  assert.match(prompt, /legacy\/lab compatibility wrapper only/);
  assert.match(prompt, /Do not migrate private data into Brain source repos/);
  assert.match(prompt, /assistantLogicSkills/);
  assert.match(prompt, /send_image\/send_document compatibility/);
  assert.doesNotMatch(prompt, /Todos, projects, CRM, reminders/);
  assert.doesNotMatch(prompt, /Main-loop routing parity/);
  assert.doesNotMatch(prompt, /Generated images/);
  assert.doesNotMatch(prompt, /Scratch web pages \/ codex-chat-web/);
  assert.doesNotMatch(prompt, /Natural todo intent/);
  assert.doesNotMatch(prompt, /todo: X/);
  assert.doesNotMatch(prompt, /todo-add\.js -- --title/);
});

test("buildPrompt loads runtime roots, AGENTS, pack prompts, and assistant-agent-logic skills from configured roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-runtime-context-"));
  try {
    const workspace = path.join(root, "assistant-data");
    const control = path.join(root, "brain");
    const codexChat = path.join(root, "codex-chat");
    const assistantLogic = path.join(root, "assistant-agent-logic");
    const pack = path.join(control, "assistant-packs", "core");
    await mkdir(path.join(workspace, ".claude", "repo-registry"), { recursive: true });
    await mkdir(path.join(control, "assistant-packs", "core", "prompts"), { recursive: true });
    await mkdir(path.join(codexChat, "behavior"), { recursive: true });
    await mkdir(path.join(assistantLogic, "config", "skills"), { recursive: true });
    await writeFile(path.join(control, "AGENTS.md"), "BRAIN_AGENTS_CONTEXT_MARKER\n");
    await writeFile(path.join(codexChat, "behavior", "AGENTS.md"), "CODEX_CHAT_BEHAVIOR_AGENTS_MARKER\n");
    await writeFile(path.join(assistantLogic, "CLAUDE.md"), "ASSISTANT_AGENT_LOGIC_CLAUDE_MARKER\n");
    await writeFile(path.join(assistantLogic, "config", "skills", "todo.md"), "ASSISTANT_AGENT_LOGIC_TODO_SKILL_MARKER\n");
    await writeFile(path.join(pack, "assistant-pack.json"), JSON.stringify({
      schemaVersion: 1,
      id: "core",
      name: "Core",
      prompts: ["prompts/runtime-boundary.md"],
    }));
    await writeFile(path.join(pack, "prompts", "runtime-boundary.md"), "ASSISTANT_PACK_PROMPT_MARKER\n");
    await writeFile(path.join(workspace, ".claude", "repo-registry", "index.yaml"), [
      "version: 1",
      "repos:",
      "  codex-chat:",
      "    alias: codex-chat",
      "    host: local",
      `    path: ${JSON.stringify(codexChat)}`,
      "    repo_name: codex-chat",
      "  assistant-claude:",
      "    alias: assistant-claude",
      "    host: local",
      `    path: ${JSON.stringify(assistantLogic)}`,
      "    repo_name: assistant-agent-logic",
      "  assistant-agent-data:",
      "    alias: assistant-agent-data",
      "    host: local",
      `    path: ${JSON.stringify(workspace)}`,
      "    repo_name: assistant-agent-data",
      "",
    ].join("\n"));
    const setupContextPath = path.join(control, "private", "setup-context.json");
    await mkdir(path.dirname(setupContextPath), { recursive: true });
    await writeFile(setupContextPath, `${JSON.stringify({ version: 1, repoPath: control, workspaceRoot: workspace }, null, 2)}\n`);

    const prompt = buildPrompt({
      id: "evt_context",
      kind: "message",
      workspaceId: "personal",
      entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
      text: "show runtime context",
      receivedAt: "2026-05-21T00:00:00.000Z",
    }, {
      workspacePath: workspace,
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
      runtimeContext: {
        controlPlaneRoot: control,
        repoRegistryPath: path.join(workspace, ".claude", "repo-registry", "index.yaml"),
        setupContextPath,
        assistantPackRoot: pack,
      },
    });

    assert.match(prompt, new RegExp(escapeRegExp(control)));
    assert.match(prompt, new RegExp(escapeRegExp(codexChat)));
    assert.match(prompt, new RegExp(escapeRegExp(assistantLogic)));
    assert.match(prompt, new RegExp(escapeRegExp(workspace)));
    assert.match(prompt, /BRAIN_AGENTS_CONTEXT_MARKER/);
    assert.match(prompt, /CODEX_CHAT_BEHAVIOR_AGENTS_MARKER/);
    assert.match(prompt, /ASSISTANT_AGENT_LOGIC_CLAUDE_MARKER/);
    assert.match(prompt, /ASSISTANT_PACK_PROMPT_MARKER/);
    assert.match(prompt, /ASSISTANT_AGENT_LOGIC_TODO_SKILL_MARKER/);
    assert.match(prompt, /do not infer these from the private workspace cwd/);
    assert.match(prompt, /Available assistant-agent-logic skill docs: .*todo\.md/);
    assert.match(prompt, /For any lab dispatch_subagent directive include profile, summary, model, effort, and idempotencyKey/);
    assert.doesNotMatch(prompt, /Use profile researcher for research\/inspection\/account lookup/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildPrompt injects active subagent snapshots for natural-language steering", () => {
  const prompt = buildPrompt({
    id: "evt_steer",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "tell the implementer to focus on tests",
    receivedAt: "2026-05-21T00:00:00.000Z",
  }, {
    workspacePath: "/tmp/personal",
    primaryEntrypointId: "telegram-main",
    enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
  }, {
    activeSubagents: {
      jobs: [{
        id: "job_feedfacecafebeef",
        ref: "feedface",
        status: "running",
        profile: "implementer",
        provider: "provider:codex",
        summary: "Fix tests",
        ownerType: "main",
        route: "return_to_main",
        resultTarget: "main",
        model: "gpt-5.5",
        effort: "high",
        enqueuedAt: "2026-05-21T00:00:00.000Z",
        startedAt: "2026-05-21T00:00:01.000Z",
        elapsedSec: 3,
        steerable: true,
      }],
      omitted: 0,
    },
  });

  assert.match(prompt, /Active subagent jobs/);
  assert.match(prompt, /ref=feedface/);
  assert.match(prompt, /id=job_feedfacecafebeef/);
  assert.match(prompt, /steerable=true/);
  assert.match(prompt, /emit steer_subagent only when exactly one matching job/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("BrainRuntime consumes dispatch_subagent actions through lifecycle port", async () => {
  const store = new InMemorySubagentJobStore();
  const subagents = new SubagentLifecycle({
    workspaceId: "personal",
    store,
    executor: new StaticSubagentExecutor({ id: "runtime-static", outputText: "child done" }),
    artifactRoot: "/tmp/brain-runtime-subagents",
    idFactory: () => "job_runtime_1",
  });
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new DirectiveProviderAdapter(),
    subagents,
  });

  const result = await runtime.handleInboundEvent({
    id: "evt_subagent",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "delegate",
    receivedAt: "2026-05-21T00:00:00.000Z",
  });
  await subagents.waitForIdle();

  assert.deepEqual(result.subagentJobIds, ["job_runtime_1"]);
  assert.equal(result.actions.some((action) => action.type === "dispatch_subagent"), false);
  const dispatchStatus = result.actions.find((action) => action.type === "send_text");
  assert.match(dispatchStatus?.type === "send_text" ? dispatchStatus.text : "", /Sub: child/);
  assert.match(dispatchStatus?.type === "send_text" ? dispatchStatus.text : "", /implementer · gpt-5.5 · high/);
  assert.match(dispatchStatus?.type === "send_text" ? dispatchStatus.text : "", /ref: runtime_/);
  assert.match(dispatchStatus?.type === "send_text" ? dispatchStatus.text : "", /id: job_runtime_1/);
  assert.equal((await store.get("job_runtime_1"))?.status, "completed");
});

test("BrainRuntime streams dispatch feedback when provider emits a subagent action mid-turn", async () => {
  const store = new InMemorySubagentJobStore();
  const subagents = new SubagentLifecycle({
    workspaceId: "personal",
    store,
    executor: new StaticSubagentExecutor({ id: "runtime-static", outputText: "child done" }),
    artifactRoot: "/tmp/brain-runtime-subagents",
    idFactory: () => "job_stream_1",
  });
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
    },
    provider: new FakeProviderAdapter([
      { type: "action", action: { type: "dispatch_subagent", profile: "researcher", prompt: "Research", summary: "Research parity", model: "gpt-5.5", effort: "high", idempotencyKey: "research-1" } },
      { type: "final", text: "Queued." },
    ]),
    subagents,
  });
  const streamed: string[] = [];

  const result = await runtime.handleInboundEvent({
    id: "evt_stream_subagent",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "research this",
    receivedAt: "2026-05-21T00:00:00.000Z",
  }, {
    onStreamingAction: (action) => {
      if (action.type === "send_text") streamed.push(action.text);
    },
  });

  assert.deepEqual(result.subagentJobIds, ["job_stream_1"]);
  assert.equal(result.streamingActions.length, 1);
  assert.match(streamed[0] ?? "", /Sub: Research parity/);
  assert.equal(result.actions.some((action) => action.type === "send_text" && /Research parity/.test(action.text)), false);
});


test("BrainRuntime consumes legacy cancel_job directives through subagent control port", async () => {
  const calls: Array<{ ref: string; reason?: string }> = [];
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "telegram-main",
      enabledEntrypoints: { "telegram-main": { kind: "telegram", enabled: true } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new FakeProviderAdapter([{
      type: "final",
      text: '```codex-chat\n{"version":1,"actions":[{"type":"cancel_job","jobId":"job_cancel_me","idempotencyKey":"cancel-1"}]}\n```',
    }]),
    subagents: {
      async dispatch() { throw new Error("not expected"); },
      async requestCancel(ref, reason) {
        calls.push({ ref, reason });
        return { status: "success", ref, message: `cancelled ${ref}`, job: { id: ref, profile: "implementer", status: "cancelled" }, previousStatus: "running" } as never;
      },
    },
  });

  const result = await runtime.handleInboundEvent({
    id: "evt_cancel",
    kind: "message",
    workspaceId: "personal",
    entrypoint: { entrypointId: "telegram-main", channelKind: "telegram" },
    text: "cancel that",
    receivedAt: "2026-05-21T00:00:00.000Z",
  });

  assert.deepEqual(calls, [{ ref: "job_cancel_me", reason: "runtime directive" }]);
  assert.equal(result.controlResults[0]?.status, "success");
  assert.equal(result.actions.some((action) => action.type === "cancel_subagent"), false);
});

test("fake entrypoint smoke sends inbound event through runtime and dispatches outbound action", async () => {
  const entrypoint = new FakeEntrypointAdapter({
    workspaceId: "personal",
    entrypointId: "fake-main",
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });
  const runtime = new BrainRuntime({
    workspaceId: "personal",
    workspace: {
      workspacePath: "/tmp/personal",
      primaryEntrypointId: "fake-main",
      enabledEntrypoints: { "fake-main": { kind: "fake", enabled: true, displayName: "Fake main" } },
      outboundDefaults: { route: "originating-entrypoint", allowCrossEntrypointReplies: false },
      promptContext: { includeActiveEntrypointMetadata: true, exposeChannelSecrets: false },
    },
    provider: new FakeProviderAdapter(),
  });
  const bridge = new RuntimeEntrypointBridge({ runtime, entrypoint });

  entrypoint.enqueueText("ping", { conversationId: "fake-conversation" });
  entrypoint.close();
  const result = await bridge.run({ maxEvents: 1 });

  assert.equal(result.stoppedReason, "max-events");
  assert.equal(result.processed.length, 1);
  assert.equal(entrypoint.dispatchedActions.length, 1);
  assert.equal(entrypoint.dispatchedActions[0]?.type, "send_text");
  assert.match(entrypoint.dispatchedActions[0]?.type === "send_text" ? entrypoint.dispatchedActions[0].text : "", /Fake: ping/);
  assert.equal(entrypoint.dispatchedActions[0]?.target?.entrypointId, "fake-main");
  assert.equal(result.processed[0]?.dispatchResults[0]?.status, "queued");
});

class DirectiveProviderAdapter implements ProviderAdapter {
  readonly id = "directive";
  async createSession(): Promise<ProviderSession> {
    return new DirectiveProviderSession();
  }
}

class DirectiveProviderSession implements ProviderSession {
  readonly id = "directive_session";
  readonly provider = "directive";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<ProviderHealth> {
    return { ok: true, provider: this.provider, sessionId: this.id };
  }
  async *sendTurn(_turn: ProviderTurn): AsyncIterable<ProviderTurnEvent> {
    yield {
      type: "final",
      text: '```brain-actions\n{"version":1,"actions":[{"type":"dispatch_subagent","profile":"implementer","prompt":"Do a child task","summary":"child","model":"gpt-5.5","effort":"high","idempotencyKey":"child-1"}]}\n```',
    };
  }
}

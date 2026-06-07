import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeEntrypointAdapter } from "@brain/entrypoint-protocol";
import { BrainRuntime } from "./runtime.js";
import { FakeProviderAdapter } from "./provider.js";
import { formatAssistantCommandOutput, sanitizeUserFacingText } from "./user-facing-format.js";

test("formats todo command JSON as clean numbered user-facing text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-format-todos-"));
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "todos.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-06-07T00:00:00.000Z",
      todos: [
        { id: "td_a111111111111111", title: "Buy coffee", description: "whole beans", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z" },
        { id: "td_b222222222222222", title: "Call dentist", description: "", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z" },
      ],
    }));

    const list = formatAssistantCommandOutput({
      script: "todo-list.js",
      stdout: {
        ok: true,
        count: 2,
        todos: [
          { id: "td_a111111111111111", title: "Buy coffee", description: "whole beans", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z" },
          { id: "td_b222222222222222", title: "Call dentist", description: "", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z" },
        ],
      },
      workspacePath: root,
    });
    assert.equal(list, "Current todos:\n1. Buy coffee — whole beans\n2. Call dentist");
    assert.doesNotMatch(list ?? "", /td_|createdAt|updatedAt|\{/);

    const add = formatAssistantCommandOutput({
      script: "todo-add.js",
      stdout: { ok: true, todo: { id: "td_c333333333333333", title: "Call dentist", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z" } },
      workspacePath: root,
    });
    assert.match(add ?? "", /^Added todo: Call dentist\n\nCurrent todos:\n1\. Buy coffee/m);
    assert.match(add ?? "", /2\. Call dentist/);
    assert.doesNotMatch(add ?? "", /td_|createdAt|updatedAt|\{/);

    const deleted = formatAssistantCommandOutput({
      script: "todo-delete.js",
      stdout: { ok: true, deleted: { id: "td_a111111111111111", title: "Buy coffee" } },
      workspacePath: root,
    });
    assert.match(deleted ?? "", /^Removed todo: Buy coffee\n\nCurrent todos:\n1\. Buy coffee/m);
    assert.doesNotMatch(deleted ?? "", /td_|createdAt|updatedAt|\{/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime sanitizes provider raw todo JSON before dispatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brain-runtime-format-"));
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "todos.json"), JSON.stringify({ version: 1, todos: [{ id: "td_a111111111111111", title: "Pay card", description: "", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z" }] }));
    const entrypoint = new FakeEntrypointAdapter({ workspaceId: "personal", entrypointId: "fake-main" });
    const runtime = new BrainRuntime({
      workspaceId: "personal",
      workspace: { workspacePath: root, primaryEntrypointId: "fake-main", enabledEntrypoints: { "fake-main": { kind: "fake", enabled: true } } },
      provider: new FakeProviderAdapter([{ type: "final", text: JSON.stringify({ ok: true, details: { script: "todo-list.js", workspaceRoot: root, stdout: { ok: true, count: 1, todos: [{ id: "td_a111111111111111", title: "Pay card", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z" }] } } }, null, 2) }]),
    });
    const event = entrypoint.enqueueText("list todos", { conversationId: "test" });
    const result = await runtime.handleInboundEvent(event);
    const text = result.actions[0]?.type === "send_text" ? result.actions[0].text : "";
    assert.equal(text, "Current todos:\n1. Pay card");
    assert.doesNotMatch(text, /td_|createdAt|updatedAt|\{/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sanitizer formats reminders, calendar, and email JSON without raw internals", () => {
  const reminders = sanitizeUserFacingText(JSON.stringify({ ok: true, count: 1, reminders: [{ id: "rm_abc123abc123abcd", title: "Weekly review", _description: "every Friday at 17:00", createdAt: "x", updatedAt: "x" }] }));
  assert.equal(reminders, "Current reminders:\n1. Weekly review — every Friday at 17:00");
  assert.doesNotMatch(reminders, /rm_|createdAt|updatedAt|\{/);

  const events = sanitizeUserFacingText(JSON.stringify([{ summary: "Lunch", start: { dateTime: "2026-06-08T12:00:00-04:00" }, end: { dateTime: "2026-06-08T13:00:00-04:00" }, id: "raw-event-id" }]));
  assert.match(events, /Calendar events:\n1\. Lunch/);
  assert.doesNotMatch(events, /\{/);

  const emails = sanitizeUserFacingText(JSON.stringify([{ from: "Jane <jane@example.com>", subject: "Hello", date: "2026-06-07T12:00:00.000Z", id: "msg-1", snippet: "Checking in" }]));
  assert.match(emails, /Emails:\n1\. Jane <jane@example.com> — Hello/);
  assert.doesNotMatch(emails, /\{/);
});

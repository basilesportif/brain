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
    assert.equal(list, "main_loop: model=gpt-5.5 effort=medium\n\nCurrent todos:\n\n1. Buy coffee — whole beans\n2. Call dentist");
    assert.doesNotMatch(list ?? "", /td_|createdAt|updatedAt|\{/);

    const add = formatAssistantCommandOutput({
      script: "todo-add.js",
      stdout: { ok: true, todo: { id: "td_c333333333333333", title: "Call dentist", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z" } },
      workspacePath: root,
    });
    assert.match(add ?? "", /^main_loop: model=gpt-5\.5 effort=medium\n\nAdded todo: Call dentist\n\nCurrent todos:\n\n1\. Buy coffee/m);
    assert.match(add ?? "", /2\. Call dentist/);
    assert.doesNotMatch(add ?? "", /td_|createdAt|updatedAt|\{/);

    const deleted = formatAssistantCommandOutput({
      script: "todo-delete.js",
      stdout: { ok: true, deleted: { id: "td_a111111111111111", title: "Buy coffee" } },
      workspacePath: root,
    });
    assert.match(deleted ?? "", /^main_loop: model=gpt-5\.5 effort=medium\n\nRemoved todo: Buy coffee\n\nCurrent todos:\n\n1\. Buy coffee/m);
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
    assert.equal(text, "main_loop: model=gpt-5.5 effort=medium\n\nCurrent todos:\n\n1. Pay card");
    assert.doesNotMatch(text, /td_|createdAt|updatedAt|\{/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sanitizer formats reminders, calendar, and email JSON without raw internals", () => {
  const reminders = sanitizeUserFacingText(JSON.stringify({ ok: true, count: 1, reminders: [{ id: "rm_abc123abc123abcd", title: "Weekly review", _description: "every Friday at 17:00", createdAt: "x", updatedAt: "x" }] }));
  assert.equal(reminders, "main_loop: model=gpt-5.5 effort=medium\n\nCurrent reminders:\n1. Weekly review — every Friday at 17:00");
  assert.doesNotMatch(reminders, /rm_|createdAt|updatedAt|\{/);

  const events = sanitizeUserFacingText(JSON.stringify([{ summary: "Lunch", start: { dateTime: "2026-06-08T12:00:00-04:00" }, end: { dateTime: "2026-06-08T13:00:00-04:00" }, id: "raw-event-id" }]));
  assert.match(events, /Calendar events:\n1\. Lunch/);
  assert.doesNotMatch(events, /\{/);

  const emails = sanitizeUserFacingText(JSON.stringify([{ from: "Jane <jane@example.com>", subject: "Hello", date: "2026-06-07T12:00:00.000Z", id: "msg-1", snippet: "Checking in" }]));
  assert.match(emails, /Emails:\n1\. Jane <jane@example.com> — Hello/);
  assert.doesNotMatch(emails, /\{/);
});

test("formats project detail commands without collapsing them to saved summaries", () => {
  const projectView = formatAssistantCommandOutput({
    script: "project-view.js",
    stdout: {
      ok: true,
      project: {
        id: "pj_abc123abc123abcd",
        name: "Launch Site",
        description: "Refresh landing page",
        status: "active",
        targetDate: "2026-07-01",
        notes: [{ id: "pn_abc123abc123abcd", createdAt: "2026-06-07T00:00:00.000Z", updatedAt: "2026-06-07T00:00:00.000Z", text: "Kickoff note", metadata: { title: "Kickoff", summary: "Scope and owners" } }],
        resources: [{ label: "Brief", url: "https://example.com/brief" }],
      },
      linkedPeople: [{ id: "ct_abc123abc123abcd", name: "Jane Roe", email: "jane@example.com", status: "active" }],
      linkedBusinesses: [{ id: "bz_abc123abc123abcd", name: "Acme", status: "prospecting", dealValue: 12000 }],
      openTasks: [{ id: "pt_abc123abc123abcd", title: "Draft copy", status: "open" }],
      linkedTodos: [{ id: "td_abc123abc123abcd", title: "Book kickoff", createdAt: "x", updatedAt: "x" }],
    },
  });
  assert.match(projectView ?? "", /^main_loop: model=gpt-5\.5 effort=medium\n\nProject: Launch Site/m);
  assert.match(projectView ?? "", /People:\n1\. Jane Roe/);
  assert.match(projectView ?? "", /Notes:\n1\. Kickoff — Scope and owners/);
  assert.doesNotMatch(projectView ?? "", /Project saved|pj_|pn_|ct_|bz_|pt_|createdAt|updatedAt|\{/);

  const notes = formatAssistantCommandOutput({
    script: "project-notes-list.js",
    stdout: { ok: true, count: 1, notes: [{ projectId: "pj_abc123abc123abcd", projectName: "Launch Site", noteId: "pn_abc123abc123abcd", createdAt: "x", updatedAt: "x", metadata: { title: "Canonical brief", kind: "canonical-index", category: "website", summary: "Current source of truth", tags: ["website"] } }] },
  });
  assert.equal(notes, "main_loop: model=gpt-5.5 effort=medium\n\nProject notes:\n1. Canonical brief — Launch Site — canonical-index — website — Current source of truth — tags: website");
  assert.doesNotMatch(notes ?? "", /pj_|pn_|createdAt|updatedAt|\{/);
});

test("formats CRM detail commands without raw IDs or vague saved messages", () => {
  const crmView = formatAssistantCommandOutput({
    script: "crm-view.js",
    stdout: {
      ok: true,
      person: { id: "ct_abc123abc123abcd", name: "Jane Roe", email: "jane@example.com", company: "Acme", title: "CEO", status: "active", priority: "high", notes: "Met at expo", createdAt: "x", updatedAt: "x" },
      businesses: [{ id: "bz_abc123abc123abcd", name: "Acme", status: "prospecting", dealValue: 12000 }],
      correspondence: [{ id: "co_abc123abc123abcd", type: "email", summary: "Intro sent", date: "2026-06-07", followUpNeeded: true, followUpDate: "2026-06-14", createdAt: "x" }],
      pendingFollowUps: [{ id: "co_abc123abc123abcd", type: "email", summary: "Intro sent", date: "2026-06-07", followUpNeeded: true, followUpDate: "2026-06-14", createdAt: "x" }],
    },
  });
  assert.match(crmView ?? "", /^main_loop: model=gpt-5\.5 effort=medium\n\nCRM person: Jane Roe/m);
  assert.match(crmView ?? "", /Businesses:\n1\. Acme/);
  assert.match(crmView ?? "", /Pending follow-ups:\n1\. Intro sent/);
  assert.doesNotMatch(crmView ?? "", /CRM person saved|ct_|bz_|co_|createdAt|updatedAt|\{/);

  const history = formatAssistantCommandOutput({ script: "crm-history.js", stdout: { ok: true, count: 1, correspondence: [{ id: "co_abc123abc123abcd", type: "call", summary: "Discovery call", date: "2026-06-07", personName: "Jane Roe", notes: "Good fit", createdAt: "x" }] } });
  assert.equal(history, "main_loop: model=gpt-5.5 effort=medium\n\nCRM history:\n1. Discovery call — 2026-06-07 — call — Jane Roe\n   Notes: Good fit");
  assert.doesNotMatch(history ?? "", /co_|createdAt|\{/);

  const followUps = formatAssistantCommandOutput({ script: "crm-follow-ups.js", stdout: { ok: true, count: 1, followUps: [{ id: "co_abc123abc123abcd", type: "email", summary: "Send proposal", date: "2026-06-07", personName: "Jane Roe", followUpNeeded: true, followUpDate: "2026-06-14", createdAt: "x" }] } });
  assert.match(followUps ?? "", /^main_loop: model=gpt-5\.5 effort=medium\n\nCRM follow-ups:\n1\. Send proposal/m);
  assert.doesNotMatch(followUps ?? "", /co_|createdAt|\{/);

  const logged = formatAssistantCommandOutput({ script: "crm-log.js", stdout: { ok: true, correspondence: { id: "co_abc123abc123abcd", type: "email", summary: "Sent deck", followUpNeeded: true, followUpDate: "2026-06-14", date: "2026-06-07", createdAt: "x" } } });
  assert.equal(logged, "main_loop: model=gpt-5.5 effort=medium\n\nLogged CRM email: Sent deck\nDate: 2026-06-07\nFollow-up: 2026-06-14");
  assert.doesNotMatch(logged ?? "", /co_|createdAt|\{/);
});

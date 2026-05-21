import test from "node:test";
import assert from "node:assert/strict";
import { parseBrainDirectives } from "./directives.js";

test("parses brain action blocks and strips them from text", () => {
  const result = parseBrainDirectives(`Visible\n\n\`\`\`brain-actions\n{"version":1,"actions":[{"type":"send_text","text":"Hi","idempotencyKey":"a"}]}\n\`\`\``);
  assert.equal(result.cleanText, "Visible");
  assert.equal(result.errors.length, 0);
  assert.equal(result.blocks[0]?.actions[0]?.type, "send_text");
});

test("normalizes legacy codex-chat image directives to send_artifact", () => {
  const result = parseBrainDirectives(`\`\`\`codex-chat\n{"version":1,"actions":[{"type":"send_image","path":"/tmp/a.png","idempotencyKey":"img"}]}\n\`\`\``);
  assert.equal(result.errors.length, 0);
  assert.equal(result.blocks[0]?.actions[0]?.type, "send_artifact");
});

test("normalizes legacy codex-chat target and subagent control directives", () => {
  const result = parseBrainDirectives(`\`\`\`codex-chat
{"version":1,"actions":[
  {"type":"send_text","chatId":123,"replyToMessageId":456,"text":"Hi","idempotencyKey":"txt"},
  {"type":"cancel_job","jobId":"job_123","idempotencyKey":"cancel"},
  {"type":"notify_owner","text":"Heads up","idempotencyKey":"notify"}
]}\n\`\`\``);

  assert.equal(result.errors.length, 0);
  const [sendText, cancel, notify] = result.blocks[0]?.actions ?? [];
  assert.equal(sendText?.type, "send_text");
  assert.equal(sendText?.target?.conversationId, "123");
  assert.equal(sendText?.target?.replyToExternalMessageId, "456");
  assert.equal(cancel?.type, "cancel_subagent");
  assert.equal(cancel?.type === "cancel_subagent" ? cancel.jobId : "", "job_123");
  assert.equal(notify?.type, "send_text");
  assert.equal(notify?.target?.route, "admins");
});

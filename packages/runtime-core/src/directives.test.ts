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

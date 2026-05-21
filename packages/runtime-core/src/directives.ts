import { z } from "zod";
import type { BrainOutboundAction } from "@brain/entrypoint-protocol";

const routeSchema = z.enum(["return_to_main", "send_to_user", "send_progress_and_return", "send_to_admins", "store_only", "silent"]);
const targetSchema = z.object({
  route: z.enum(["originating-entrypoint", "explicit-entrypoint", "admins", "store-only", "silent"]).optional(),
  entrypointId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  replyToExternalMessageId: z.string().min(1).optional(),
}).optional();
const legacyTelegramIdSchema = z.union([z.number().int(), z.string().min(1)]).optional();
const legacyTelegramTargetFields = {
  chatId: legacyTelegramIdSchema,
  replyToMessageId: legacyTelegramIdSchema,
};
const baseAction = z.object({
  id: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  originatingEventId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  target: targetSchema,
  metadata: z.record(z.string(), z.any()).optional(),
});

const sendTextAction = baseAction.extend({
  type: z.literal("send_text"),
  ...legacyTelegramTargetFields,
  text: z.string().min(1),
  format: z.enum(["text", "markdown", "markdownv2"]).optional(),
});

const sendArtifactAction = baseAction.extend({
  type: z.literal("send_artifact"),
  ...legacyTelegramTargetFields,
  path: z.string().min(1).optional(),
  uri: z.string().min(1).optional(),
  caption: z.string().optional(),
  asDocument: z.boolean().optional(),
  deleteAfterSend: z.boolean().optional(),
  mimeType: z.string().optional(),
}).refine((value) => value.path || value.uri, "send_artifact requires path or uri");

const legacySendImageAction = baseAction.extend({
  type: z.literal("send_image"),
  ...legacyTelegramTargetFields,
  path: z.string().min(1).optional(),
  fileId: z.string().min(1).optional(),
  caption: z.string().optional(),
  asDocument: z.boolean().optional(),
  deleteAfterSend: z.boolean().optional(),
}).refine((value) => value.path || value.fileId, "send_image requires path or fileId");

const legacySendDocumentAction = baseAction.extend({
  type: z.literal("send_document"),
  ...legacyTelegramTargetFields,
  path: z.string().min(1),
  caption: z.string().optional(),
});

const showStatusAction = baseAction.extend({
  type: z.literal("show_status"),
  status: z.string().min(1),
  text: z.string().optional(),
});

const requestClarificationAction = baseAction.extend({
  type: z.literal("request_clarification"),
  ...legacyTelegramTargetFields,
  text: z.string().min(1),
  choices: z.array(z.string().min(1)).optional(),
});

const reactAction = baseAction.extend({
  type: z.literal("react"),
  chatId: legacyTelegramIdSchema,
  messageId: legacyTelegramIdSchema,
  emoji: z.string().min(1),
});
const editMessageAction = baseAction.extend({
  type: z.literal("edit_message"),
  ...legacyTelegramTargetFields,
  text: z.string().min(1),
  externalMessageId: z.string().min(1).optional(),
  format: z.enum(["text", "markdown", "markdownv2"]).optional(),
});
const dispatchSubagentAction = baseAction.extend({
  type: z.literal("dispatch_subagent"),
  profile: z.string().min(1),
  prompt: z.string().min(1),
  summary: z.string().min(1),
  route: routeSchema.optional(),
  timeoutSec: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  images: z.array(z.string().min(1)).optional(),
});
const legacyCancelJobAction = baseAction.extend({
  type: z.literal("cancel_job"),
  jobId: z.string().min(1),
  reason: z.string().min(1).optional(),
});
const steerSubagentAction = baseAction.extend({
  type: z.literal("steer_subagent"),
  jobId: z.string().min(1),
  text: z.string().min(1),
});
const notifyOwnerAction = baseAction.extend({
  type: z.literal("notify_owner"),
  text: z.string().min(1),
});
const enqueueMainAction = baseAction.extend({
  type: z.literal("enqueue_main"),
  text: z.string().min(1),
  route: routeSchema.optional(),
});

const rawActionSchema = z.discriminatedUnion("type", [
  sendTextAction,
  sendArtifactAction,
  legacySendImageAction,
  legacySendDocumentAction,
  showStatusAction,
  requestClarificationAction,
  reactAction,
  editMessageAction,
  dispatchSubagentAction,
  legacyCancelJobAction,
  steerSubagentAction,
  notifyOwnerAction,
  enqueueMainAction,
]);

const directiveBlockSchema = z.object({
  version: z.literal(1),
  actions: z.array(rawActionSchema).min(1),
});

export interface DirectiveBlock {
  version: 1;
  actions: BrainOutboundAction[];
}

export interface DirectiveParseResult {
  cleanText: string;
  blocks: DirectiveBlock[];
  errors: string[];
}

interface TextRange { start: number; end: number }
interface RawDirectiveBlock extends TextRange { body: string; complete: boolean }
interface SourceLine extends TextRange { content: string }

const directiveStart = /^[ \t]*```(?:brain-actions|codex-chat)[ \t]*$/;
const directiveEnd = /^[ \t]*```[ \t]*$/;

export function parseBrainDirectives(text: string): DirectiveParseResult {
  const blocks: DirectiveBlock[] = [];
  const errors: string[] = [];
  const rawBlocks = collectDirectiveBlocks(text);
  for (const rawBlock of rawBlocks) {
    if (!rawBlock.complete) {
      errors.push("Unterminated brain action directive block");
      continue;
    }
    try {
      const parsed = JSON.parse(rawBlock.body);
      const block = directiveBlockSchema.parse(parsed);
      const actions = block.actions.map(normalizeAction);
      for (const action of actions) {
        if (action.type !== "enqueue_main" && !action.idempotencyKey) {
          errors.push(`Directive action ${action.type} is missing idempotencyKey`);
        }
      }
      blocks.push({ version: 1, actions });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { cleanText: stripRanges(text, rawBlocks).trim(), blocks, errors };
}

function normalizeAction(action: z.infer<typeof rawActionSchema>): BrainOutboundAction {
  if (action.type === "send_image") {
    return applyLegacyTelegramTarget({
      ...action,
      type: "send_artifact",
      uri: action.fileId ? `telegram-file:${action.fileId}` : undefined,
      mimeType: "image/*",
    }, action);
  }
  if (action.type === "send_document") {
    return applyLegacyTelegramTarget({ ...action, type: "send_artifact", asDocument: true }, action);
  }
  if (action.type === "cancel_job") {
    return { ...action, type: "cancel_subagent" };
  }
  if (action.type === "notify_owner") {
    return { ...action, type: "send_text", target: { ...(action.target ?? {}), route: "admins" } };
  }
  return applyLegacyTelegramTarget(action as unknown as BrainOutboundAction, action as { chatId?: string | number; replyToMessageId?: string | number; messageId?: string | number });
}

function applyLegacyTelegramTarget<T extends BrainOutboundAction>(
  action: T,
  legacy: { chatId?: string | number; replyToMessageId?: string | number; messageId?: string | number },
): T {
  const target = { ...(action.target ?? {}) };
  if (legacy.chatId !== undefined && !target.conversationId) {
    target.route = target.route ?? "explicit-entrypoint";
    target.conversationId = String(legacy.chatId);
  }
  const replyId = legacy.replyToMessageId ?? legacy.messageId;
  if (replyId !== undefined && !target.replyToExternalMessageId) {
    target.replyToExternalMessageId = String(replyId);
  }
  return Object.keys(target).length > 0 ? { ...action, target } : action;
}

function collectDirectiveBlocks(text: string): RawDirectiveBlock[] {
  const blocks: RawDirectiveBlock[] = [];
  const lines = collectLines(text);
  for (let i = 0; i < lines.length; i++) {
    const startLine = lines[i];
    if (!startLine || !directiveStart.test(startLine.content)) continue;
    const bodyStart = startLine.end;
    let endLine: SourceLine | undefined;
    let endLineIndex = i;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j];
      if (candidate && directiveEnd.test(candidate.content)) {
        endLine = candidate;
        endLineIndex = j;
        break;
      }
    }
    if (endLine) {
      blocks.push({ start: startLine.start, end: endLine.end, body: text.slice(bodyStart, endLine.start), complete: true });
      i = endLineIndex;
    } else {
      blocks.push({ start: startLine.start, end: text.length, body: text.slice(bodyStart), complete: false });
      break;
    }
  }
  return blocks;
}

function collectLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(linePattern)) {
    if (match[0] === "" && match.index === text.length) break;
    const start = match.index ?? 0;
    const raw = match[0];
    lines.push({ start, end: start + raw.length, content: raw.replace(/(?:\r\n|\n|\r)$/, "") });
  }
  return lines;
}

function stripRanges(text: string, ranges: TextRange[]): string {
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    result += text.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  return `${result}${text.slice(cursor)}`;
}

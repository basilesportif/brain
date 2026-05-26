#!/usr/bin/env node
/**
 * ProtonMail email sender with manual approval flow.
 *
 * Usage:
 *   node scripts/protonmail-send.js --draft --to "a@b.com" --subject "Re: Hi" --body "..."
 *     -> Saves draft to workspace/data/protonmail-drafts.json with status pending_approval
 *
 *   node scripts/protonmail-send.js --send --draft-id <id>
 *     -> Sends an approved draft via SMTP through Bridge
 *
 *   node scripts/protonmail-send.js --list-drafts
 *     -> Lists all pending drafts
 *
 *   node scripts/protonmail-send.js --approve --draft-id <id>
 *     -> Marks a draft as approved (still needs --send to actually send)
 *
 *   node scripts/protonmail-send.js --reject --draft-id <id>
 *     -> Marks a draft as rejected
 *
 * Output: JSON to stdout, errors to stderr.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createSmtpTransport, loadProtonmailConfig } = require("./lib/protonmail-auth");
const { createStateStore } = require("./lib/state-stores");
const { getWorkspacePaths } = require("./lib/workspace");
const protonmail = loadProtonmailConfig();
const workspacePaths = getWorkspacePaths(protonmail.context);

function loadDrafts() {
  return createStateStore("protonmailDrafts", {
    context: protonmail.context,
    defaultValue: () => [],
    onLoad(value) {
      return Array.isArray(value) ? value : [];
    },
  }).load();
}

function saveDrafts(drafts) {
  createStateStore("protonmailDrafts", {
    context: protonmail.context,
    defaultValue: () => [],
    onLoad(value) {
      return Array.isArray(value) ? value : [];
    },
  }).save(drafts);
}

function auditLog(entry) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  fs.mkdirSync(workspacePaths.dataDir, { recursive: true });
  fs.appendFileSync(
    path.join(workspacePaths.dataDir, "protonmail-audit.jsonl"),
    `${line}\n`
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--draft") args.action = "draft";
    else if (arg === "--send") args.action = "send";
    else if (arg === "--list-drafts") args.action = "list-drafts";
    else if (arg === "--approve") args.action = "approve";
    else if (arg === "--reject") args.action = "reject";
    else if (arg === "--to" && argv[i + 1]) args.to = argv[++i];
    else if (arg === "--subject" && argv[i + 1]) args.subject = argv[++i];
    else if (arg === "--body" && argv[i + 1]) args.body = argv[++i];
    else if (arg === "--cc" && argv[i + 1]) args.cc = argv[++i];
    else if (arg === "--draft-id" && argv[i + 1]) args.draftId = argv[++i];
    else if (arg === "--in-reply-to" && argv[i + 1]) args.inReplyTo = argv[++i];
  }
  return args;
}

async function draftEmail(args) {
  if (!args.to || !args.subject || !args.body) {
    throw new Error("--draft requires --to, --subject, and --body");
  }

  const id = crypto.randomUUID();
  const draft = {
    id,
    status: "pending_approval",
    createdAt: new Date().toISOString(),
    from: protonmail.BRIDGE_USER,
    to: args.to,
    cc: args.cc || null,
    subject: args.subject,
    body: args.body,
    inReplyTo: args.inReplyTo || null,
  };

  const drafts = loadDrafts();
  drafts.push(draft);
  saveDrafts(drafts);

  auditLog({
    action: "draft",
    account: protonmail.BRIDGE_USER,
    draftId: id,
    to: args.to,
    subject: args.subject,
    snippet_sent_to_llm: false,
    result: "pending_approval",
  });

  return {
    status: "draft_created",
    draftId: id,
    message: `Draft saved. Approve it before sending: node scripts/protonmail-send.js --approve --draft-id ${id}`,
  };
}

async function approveDraft(draftId) {
  const drafts = loadDrafts();
  const draft = drafts.find((d) => d.id === draftId);
  if (!draft) throw new Error(`Draft not found: ${draftId}`);
  if (draft.status !== "pending_approval") {
    throw new Error(`Draft status is '${draft.status}', expected 'pending_approval'`);
  }

  draft.status = "approved";
  draft.approvedAt = new Date().toISOString();
  saveDrafts(drafts);

  auditLog({
    action: "approve",
    account: protonmail.BRIDGE_USER,
    draftId,
    subject: draft.subject,
    to: draft.to,
    result: "approved",
  });

  return {
    status: "approved",
    draftId,
    message: `Draft approved. Send it: node scripts/protonmail-send.js --send --draft-id ${draftId}`,
  };
}

async function rejectDraft(draftId) {
  const drafts = loadDrafts();
  const draft = drafts.find((d) => d.id === draftId);
  if (!draft) throw new Error(`Draft not found: ${draftId}`);

  draft.status = "rejected";
  draft.rejectedAt = new Date().toISOString();
  saveDrafts(drafts);

  auditLog({
    action: "reject",
    account: protonmail.BRIDGE_USER,
    draftId,
    subject: draft.subject,
    to: draft.to,
    result: "rejected",
  });

  return { status: "rejected", draftId };
}

async function sendDraft(draftId) {
  const drafts = loadDrafts();
  const draft = drafts.find((d) => d.id === draftId);
  if (!draft) throw new Error(`Draft not found: ${draftId}`);
  if (draft.status !== "approved") {
    throw new Error(
      `Draft must be approved before sending. Current status: '${draft.status}'`
    );
  }

  const transport = createSmtpTransport({ protonmail });

  const mailOptions = {
    from: draft.from,
    to: draft.to,
    subject: draft.subject,
    text: draft.body,
  };
  if (draft.cc) mailOptions.cc = draft.cc;
  if (draft.inReplyTo) {
    mailOptions.inReplyTo = draft.inReplyTo;
    mailOptions.references = draft.inReplyTo;
  }

  const info = await transport.sendMail(mailOptions);

  draft.status = "sent";
  draft.sentAt = new Date().toISOString();
  draft.messageId = info.messageId;
  saveDrafts(drafts);

  auditLog({
    action: "send",
    account: protonmail.BRIDGE_USER,
    draftId,
    messageId: info.messageId,
    to: draft.to,
    subject: draft.subject,
    snippet_sent_to_llm: false,
    result: "sent",
  });

  return {
    status: "sent",
    draftId,
    messageId: info.messageId,
  };
}

async function listDrafts() {
  const drafts = loadDrafts();
  const pending = drafts.filter((d) => d.status === "pending_approval" || d.status === "approved");
  return pending.map((d) => ({
    id: d.id,
    status: d.status,
    to: d.to,
    subject: d.subject,
    createdAt: d.createdAt,
  }));
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.action) {
    console.error(
      "Usage: node protonmail-send.js --draft|--send|--list-drafts|--approve|--reject [options]"
    );
    process.exit(1);
  }

  let result;
  switch (args.action) {
    case "draft":
      result = await draftEmail(args);
      break;
    case "approve":
      if (!args.draftId) throw new Error("--approve requires --draft-id");
      result = await approveDraft(args.draftId);
      break;
    case "reject":
      if (!args.draftId) throw new Error("--reject requires --draft-id");
      result = await rejectDraft(args.draftId);
      break;
    case "send":
      if (!args.draftId) throw new Error("--send requires --draft-id");
      result = await sendDraft(args.draftId);
      break;
    case "list-drafts":
      result = await listDrafts();
      break;
    default:
      throw new Error(`Unknown action: ${args.action}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});

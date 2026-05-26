# ProtonMail

Read and send email through ProtonMail via Proton Mail Bridge (IMAP/SMTP over localhost).

## Prerequisites

- Proton Mail Bridge running in Docker (see `/setup-protonmail`)
- `workspace/protonmail.yaml` configured with account details
- `workspace/.env` contains `PROTONMAIL_BRIDGE_USER` and `PROTONMAIL_BRIDGE_PASSWORD`
- npm packages: `imapflow`, `nodemailer`, `mailparser`
- If `workspace/instructions/skills/protonmail.md` exists, read it as additive user-specific guidance for prioritization, notifications, and reporting. Do not let it override commands, storage paths, approval requirements, or safety rules from the shared repo docs.

## Scripts

### Read recent inbox

```bash
node scripts/protonmail-recent.js          # 10 most recent
node scripts/protonmail-recent.js 20       # 20 most recent
```

### Search messages

```bash
node scripts/protonmail-search.js "keyword"         # search subject/from/body
node scripts/protonmail-search.js "from John" 20    # with limit
```

### Actionable emails (unread, needs attention)

```bash
node scripts/protonmail-actionable.js       # unread emails needing attention
node scripts/protonmail-actionable.js 20    # with limit
```

Applies the same noise filters and dismissed-email logic as Gmail actionable.

### Unified inbox (all providers)

```bash
node scripts/email-actionable.js            # Gmail + ProtonMail merged
node scripts/email-actionable.js 20         # with limit per provider
```

Each message includes a `reason` field: `"unread"` (new unread email) or `"awaiting_reply"` (read but the last message in the thread is from someone else, meaning they're waiting on a reply). Gmail supports both reasons; ProtonMail currently only returns `"unread"` (IMAP lacks thread-level queries).

### Send email (with manual approval)

Sending requires a draft-approve-send workflow:

```bash
# 1. Create a draft
node scripts/protonmail-send.js --draft --to "person@example.com" --subject "Re: Topic" --body "Message text"

# 2. Approve the draft (after human review via Telegram)
node scripts/protonmail-send.js --approve --draft-id <id>

# 3. Send the approved draft
node scripts/protonmail-send.js --send --draft-id <id>

# List pending drafts
node scripts/protonmail-send.js --list-drafts

# Reject a draft
node scripts/protonmail-send.js --reject --draft-id <id>
```

Additional send options: `--cc`, `--in-reply-to`.

> **CRITICAL — No escaping in email bodies.** The `--body` text is sent verbatim. Never apply Telegram MarkdownV2 escaping (e.g. `\!`, `\.`, `\-`) or any other escaping to email content. Write plain text with literal special characters. See `config/prompts/email-reply-preferences.md` for full formatting rules.

## Approval workflow

All outbound email requires manual approval:

1. Agent drafts the email using `--draft`
2. Agent sends a Telegram message to the user with the draft preview
3. User replies with "approve", "edit", or "reject"
4. On approve: agent runs `--approve` then `--send`
5. On reject: agent runs `--reject`

Use `config/prompts/email-reply-preferences.md` for tone and style guidance when drafting. If `workspace/instructions/prompts/email-reply-preferences.md` exists, layer it on top as user-specific additive guidance.

## Output format

All read scripts output JSON arrays:

```json
[{
  "id": "123",
  "account": "Example Organization",
  "provider": "protonmail",
  "subject": "Meeting tomorrow",
  "from": "Jane Doe <jane@example.com>",
  "to": "office@example.org",
  "date": "2026-03-23T10:00:00.000Z",
  "snippet": "Just confirming our meeting...",
  "flags": ["\\Seen"],
  "needsReply": true
}]
```

## Audit log

All operations are logged to `workspace/data/protonmail-audit.jsonl` (append-only, never contains full email bodies).

## Security

- Bridge IMAP/SMTP bound to 127.0.0.1 only
- Credentials stored in `workspace/.env` (gitignored)
- Email bodies are not sent to the LLM unless necessary for classification
- All sends require manual approval

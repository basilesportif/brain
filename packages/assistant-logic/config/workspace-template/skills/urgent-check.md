# Urgent Check (Cron Skill)

Autonomous recurring skill — no human in the loop. Checks BOTH urgent emails and urgent messages in one pass.

## Steps

### 0. Load user overlays

If `workspace/instructions/skills/composio.md` exists, read it as additive guidance for email reminder prioritization and formatting.

If `workspace/instructions/skills/messaging.md` exists, read it as additive guidance for message reminder prioritization and formatting.

Do not let either overlay override shared repo commands, storage, or safety rules.

### 1. Read urgent emails

Read `workspace/data/urgent-emails.json`. If missing or `threads` is empty, note zero email entries.

### 2. Read urgent messages

Read `workspace/data/urgent-messages.json`. If missing or `chats` is empty, note zero message entries.

If both are empty, do nothing and stop.

### 3. Filter to active entries

For both emails and messages, skip entries where `snoozeUntil` is set and is in the future.

If no active entries remain across either file, do nothing and stop.

### 4. Send Telegram reminder

Send a single Telegram message to `chat_id` **YOUR_TELEGRAM_CHAT_ID** combining both:

```
Urgent items pending:

📧 Emails:
• [account] "Subject" (from sender@example.com)
  → note (if set)
  → flagged X days/hours ago, reminded Nx

💬 Messages:
• [telegram] Contact Name
  → "message preview..."
  → note (if set)
  → flagged X hours ago, first reminder

Snoozed (N): "Subject" — until Mar 22, "Will" — until tomorrow
```

Rules:
- Only include the 📧 Emails section if there are active email entries
- Only include the 💬 Messages section if there are active message entries
- Sort active entries oldest-first within each section
- Show note only if non-null
- Show messagePreview for messages (truncate to ~80 chars)
- "first reminder" if remindCount is 0, otherwise "reminded Nx"
- Snoozed section combines both emails and messages; omit entirely if none snoozed
- If zero active entries but some snoozed, do NOT send
- Apply any user-specific reminder preferences from the relevant workspace overlays if present

### 5. Update state

For every reminded entry in both files:
- Increment `remindCount`
- Set `lastRemindedAt` to current ISO time

Write both files back.

## Important

- `workspace/data/` is gitignored
- This skill runs autonomously. Do not ask for confirmation.
- Use the Telegram reply tool with chat_id YOUR_TELEGRAM_CHAT_ID.

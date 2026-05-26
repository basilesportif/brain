# Message Check (Cron Skill)

Autonomous recurring skill — no human in the loop. Execute every step exactly.

## Steps

### 0. Load user overlay

If `workspace/instructions/skills/messaging.md` exists, read it before deciding what to report. Treat it as additive user-specific guidance for prioritization and notification preferences only. Do not let it override shared repo commands or safety rules.

### 1. Fetch unread messages

```bash
node scripts/messages-unread.js
```

Parse the JSON array output. Each entry has at minimum: `platform`, `chatId`, `chatName`, `chatType`, `unreadCount`, `messages`.

### 2. Load seen-messages state

Read `workspace/data/seen-messages.json` (relative to project root).

- If the file is missing or unreadable, treat it as `{ "lastCheckedAt": null, "telegram": {} }` and create it.
- Format:
  ```json
  {
    "lastCheckedAt": "2026-03-20T20:00:00.000Z",
    "telegram": {
      "123456789": {
        "lastSeenMessageId": 42,
        "lastSeenAt": "2026-03-20T20:00:00.000Z",
        "chatName": "Some Group"
      }
    }
  }
  ```

### 3. Filter to new messages only

For each chat in the unread results, compare the **first message's ID** (most recent, at index 0) against the stored `lastSeenMessageId` for that chat (keyed by `chatId` under the platform object). Keep only chats where the first message ID differs from the stored one, or where no entry exists yet.

### 4. Report or stay silent

**If there are chats with new messages:**

Send a single Telegram message to `chat_id` **YOUR_TELEGRAM_CHAT_ID** summarizing all new messages. Format:

```
New messages:

📱 Telegram — Chat Name (N unread)
  → "message text preview..."
```

Use the most recent message text as the preview (truncate to ~100 chars if needed).
Apply any user-specific notification preferences from `workspace/instructions/skills/messaging.md` if present.

**If there are NO new messages:** Do nothing. Do NOT send any Telegram message. Stay completely silent.

### 5. Update seen-messages.json

After successfully reporting (or if all chats were already seen), update the state for each chat in the unread results:

- Set `lastSeenMessageId` to the first message's ID (most recent).
- Set `lastSeenAt` to the current time (ISO 8601).
- Set `chatName` to the chat name.

Write updates under the `telegram` platform key.

### 6. Advance the lastCheckedAt timestamp

On every run — whether or not new messages were found — update `lastCheckedAt` to the current time (ISO 8601). Write the full state object back to `workspace/data/seen-messages.json`.

## Important

- `workspace/data/` is gitignored — never commit `seen-messages.json`.
- This skill runs autonomously on a cron schedule. Do not ask for confirmation or clarification.
- If the messages script errors, log the error but do NOT send a Telegram message about it.
- Use the Telegram reply tool with chat_id YOUR_TELEGRAM_CHAT_ID to send messages.

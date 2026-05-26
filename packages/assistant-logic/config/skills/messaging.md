# Messaging Skill

> All `workspace/` references below resolve to the active assistant workspace.

## Usage

1. Read `workspace/messaging.yaml` for Telegram API credentials.
2. Telegram requires `api_id`, `api_hash`, and an authenticated session (via `telegram-login.js`).
3. If `workspace/instructions/skills/messaging.md` exists, read it as additive user-specific guidance for prioritization, notifications, and reporting. Do not let it override commands, storage paths, or safety rules from the shared repo docs.

## Setup

### Telegram

1. Go to https://my.telegram.org → API development tools.
2. Create an application to get `api_id` and `api_hash`.
3. Add them to `workspace/messaging.yaml` under `telegram:`.
4. Run `node scripts/telegram-login.js` to authenticate (interactive — enter phone number and code).

## Fast Path Scripts

All scripts output JSON to stdout. Run from the project root.

### Read unread messages

```bash
# Telegram — all unread chats (up to 50 dialogs)
node scripts/telegram-unread.js
node scripts/telegram-unread.js 20              # limit to 20 dialogs
node scripts/telegram-unread.js --chat "Name"   # specific chat only

# Unified wrapper
node scripts/messages-unread.js                 # all unread
node scripts/messages-unread.js --telegram      # telegram only
node scripts/messages-unread.js 20              # limit per platform
```

### Read chat history

Fetch message history from a specific Telegram chat. Unlike `telegram-unread.js` (which scans all chats for unread messages), this targets a single chat and returns read messages with cursor-based pagination.

Chat matching is exact (case-insensitive). An upstream process should resolve the correct chat name before calling this script.

```bash
# Fetch newest 20 messages from a chat (exact name match)
node scripts/telegram-history.js --chat "Alice"

# Fetch by chat ID
node scripts/telegram-history.js --chat-id "123456789"

# Fetch more messages
node scripts/telegram-history.js --chat "Alice" --limit 50

# Paginate: fetch the next older batch using nextBefore from previous response
node scripts/telegram-history.js --chat "Alice" --before 4521
```

Output is a single JSON object:

```json
{
  "platform": "telegram",
  "chatId": "123456789",
  "chatName": "Alice",
  "chatType": "private",
  "messages": [ ... ],
  "pagination": {
    "requestedLimit": 20,
    "returned": 20,
    "nextBefore": 4502,
    "hasMore": true
  }
}
```

Messages are ordered newest to oldest. To get the next page, pass `pagination.nextBefore` as `--before`. When `hasMore` is `false`, there are no older messages.

`--limit` is clamped to 100 max. `--offset` is accepted as an alias for `--before`.

### Dismissed messages

Chats dismissed from unread reports are stored in `workspace/data/dismissed-messages.json`. Chats auto-resurface if a new message arrives after the dismissal timestamp.

```bash
# Dismiss by chat name (fuzzy match against current unread)
node scripts/dismiss-message.js --chat "Name"
node scripts/dismiss-message.js --chat "Name" --platform telegram

# Dismiss by exact chat ID
node scripts/dismiss-message.js --chat-id "123456789" --platform telegram

# View current dismissals
node scripts/dismiss-message.js --list

# Undo a dismissal
node scripts/dismiss-message.js --undo --chat "Name"
node scripts/dismiss-message.js --undo --chat-id "123456789"
```

When user asks to dismiss a chat via Telegram: run `--chat` match, confirm what was dismissed.

### Urgent messages

Chats flagged for recurring reminders are stored in `workspace/data/urgent-messages.json`. Managed via `scripts/urgent-message.js`.

```bash
# Flag by chat name (fuzzy-matches against current unread chats)
node scripts/urgent-message.js --chat "Will" --note "reply about fertility"

# Flag by exact chat ID
node scripts/urgent-message.js --chat-id "123456789" --platform telegram --note "follow up"

# Resolve (removes from urgent, auto-dismisses from unread reports)
node scripts/urgent-message.js --resolve --chat "Will"
node scripts/urgent-message.js --resolve --chat-id "123456789"

# Snooze (2h, tomorrow, monday, 2026-03-25, 2026-03-25T14:00)
node scripts/urgent-message.js --snooze --chat "Will" tomorrow
node scripts/urgent-message.js --snooze --chat-id "123456789" 4h

# Update note
node scripts/urgent-message.js --note --chat "Will" "new note text"

# List all urgent entries
node scripts/urgent-message.js --list
```

When adding (`--chat`), fuzzy match runs against current unread chats. When resolving/snoozing/noting (`--resolve`, `--snooze`, `--note`), fuzzy match runs against the urgent list itself. The `--platform` flag defaults to `telegram` but accepts any string for future extensibility.

> **Routing guidance:** For message read requests from Telegram, run scripts directly via Bash in the main session — do **not** dispatch a sub-agent. Sub-agent overhead adds 20+ seconds of unnecessary latency. Same as email/calendar.

## Rules

- **Source of truth**: `workspace/messaging.yaml` — always read it first.
- **Never commit session/auth data**: Telegram session strings stay local, never in git.
- **Never log secrets**: API keys, session strings, and auth tokens must not appear in output or logs.

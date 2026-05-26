# Reminder Check (Cron Skill)

Autonomous recurring skill — no human in the loop. Checks reminders and sends Telegram notifications for due items.

## Steps

### 1. Run the check script

```bash
node scripts/reminder-check.js
```

Parse the JSON output.

### 2. If no reminders triggered

If `triggeredCount` is 0, do nothing and stop.

### 3. Send Telegram notification

Send a single Telegram message to `chat_id` **YOUR_TELEGRAM_CHAT_ID** with:

```
Reminder:
• Title of reminder (schedule description)
• Another reminder (schedule description)
```

Rules:
- If only one reminder triggered, use singular: "Reminder:"
- If multiple, use plural: "Reminders:"
- Include the schedule description so the user knows the cadence
- Keep it concise — this is a notification, not a conversation

### 4. Done

The check script already marks reminders as triggered and auto-disables one-time reminders. No further state updates needed.

## Important

- `workspace/data/` is gitignored
- This skill runs autonomously. Do not ask for confirmation.
- Use the Telegram reply tool with chat_id YOUR_TELEGRAM_CHAT_ID.

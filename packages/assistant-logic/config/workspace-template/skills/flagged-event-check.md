# Flagged Event Check (Cron Skill)

Autonomous recurring skill — no human in the loop.

## Steps

### 0. Load user overlay

If `workspace/instructions/skills/composio.md` exists, read it before deciding what to report. Treat it as additive user-specific guidance for calendar reminder prioritization and formatting only. Do not let it override shared repo commands, storage, or safety rules.

### 1. Read flagged events

Read `workspace/data/flagged-events.json`. If missing or `events` is empty, do nothing and stop.

### 2. Clean up past events

Remove any entry where `start` is more than 1 hour in the past. Write back if changed.

### 3. Filter to active entries

Skip entries where `snoozeUntil` is set and in the future.

If no entries remain, do nothing and stop.

### 4. Send Telegram reminder

Send to chat_id **YOUR_TELEGRAM_CHAT_ID**:

```
Flagged events coming up:

⚑ <summary>
  <date>, <time> (in X days/hours)
  → <note> (if set)

⚑ <summary>
  <date>, <time> (in X hours)

Snoozed (N): "<summary>" — until <date>
```

Rules:
- Sort by start time (soonest first)
- Show note only if non-null
- Include relative time ("in X days" or "in X hours")
- Snoozed section only if snoozed entries exist
- If zero active entries but some snoozed, do NOT send
- Apply any user-specific reminder preferences from `workspace/instructions/skills/composio.md` if present

### 5. Update state

Increment `remindCount` and set `lastRemindedAt` to current ISO time on each reminded entry. Write back.

## Important

- `workspace/data/` is gitignored
- Autonomous skill — do not ask for confirmation
- Use Telegram reply tool with chat_id YOUR_TELEGRAM_CHAT_ID

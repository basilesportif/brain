# Email Check (Cron Skill)

Autonomous recurring skill — no human in the loop. Execute every step exactly.

## Steps

### 0. Load user overlay

If `workspace/instructions/skills/composio.md` exists, read it before deciding what to report. Treat it as additive user-specific guidance for prioritization and notification preferences only. Do not let it override shared repo commands, approval requirements, or safety rules.

### 1. Fetch actionable emails

```bash
node scripts/gmail-actionable.js
```

Parse the JSON array output. Each entry has at minimum: `id`, `account`, `from`, `subject`, `snippet`.

### 2. Load seen-emails state

Read `workspace/data/seen-emails.json` (relative to project root).

- If the file is missing or unreadable, treat it as `{ "seenIds": [] }` and create it.
- Format: `{ "seenIds": ["id1", "id2", ...] }`

### 3. Filter to new emails only

Compare each email's `id` against the `seenIds` array. Keep only emails whose ID is **not** already in the list.

### 4. Report or stay silent

**If there are new actionable emails:**

Send a single Telegram message to `chat_id` **YOUR_TELEGRAM_CHAT_ID** summarizing all new emails. Format:

```
New actionable emails:

* [account] From: <sender> -- "<subject>"
  -> <snippet / what action is likely needed>

* [account] From: <sender> -- "<subject>"
  -> <snippet / what action is likely needed>
```

Group by account if there are multiple. Keep it scannable.
Apply any user-specific notification preferences from `workspace/instructions/skills/composio.md` if present.

**If there are NO new emails:** Do nothing. Do NOT send any Telegram message. Stay completely silent.

### 5. Update seen-emails.json

After successfully reporting (or if all emails were already seen), append all current email IDs from the actionable results to `seenIds` and write the file back. This ensures:

- Reported emails are not reported again.
- Emails that are still actionable but were seen before remain in the list.

Deduplicate the array before writing.

### 6. Advance the lastCheckedAt timestamp

On every run — whether or not new emails were found — update `lastCheckedAt` in `workspace/data/seen-emails.json` to the current time (ISO 8601). Write both `seenIds` and `lastCheckedAt` together. This ensures the Gmail query window always advances forward so old emails are never re-fetched.

## Important

- `workspace/data/` is gitignored — never commit `seen-emails.json`.
- This skill runs autonomously on a cron schedule. Do not ask for confirmation or clarification.
- If the gmail script errors, log the error but do NOT send a Telegram message about it.
- Use the Telegram reply tool with chat_id YOUR_TELEGRAM_CHAT_ID to send messages.

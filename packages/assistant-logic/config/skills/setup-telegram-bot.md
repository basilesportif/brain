# Setup Telegram Bot Skill

Sets the Telegram chat ID for bot notifications and updates cron skill placeholders.

## Pre-check

Read `workspace/telegram.yaml`. If `telegram.chat_id` is set to a real value (not empty, not "YOUR_TELEGRAM_CHAT_ID"), print:
> Telegram bot is already configured — chat ID is set.

Then stop.

## Step 1: Get chat ID

Tell the user:
> You need your Telegram chat ID for bot notifications:
> 1. Open Telegram and search for @userinfobot
> 2. Start a conversation with it — it will reply with your user info
> 3. Copy the `Id` number (e.g., `123456789`)

## Step 2: Store chat ID

Prompt for the chat ID via AskUserQuestion.

Write it to `workspace/telegram.yaml`:
```yaml
telegram:
  chat_id: "<provided_value>"
```

## Step 3: Update cron skill placeholders

Read all files in `workspace/skills/` that contain the placeholder `YOUR_TELEGRAM_CHAT_ID`. Replace every occurrence with the actual chat ID.

Files to check (all files matching `workspace/skills/*.md`):
- `workspace/skills/email-check.md`
- `workspace/skills/urgent-check.md`
- `workspace/skills/flagged-event-check.md`
- `workspace/skills/message-check.md`

Use the Edit tool with `replace_all: true` on each file.

## Step 4: Verify

Read back `workspace/telegram.yaml` and confirm the chat ID is set. Print:
> Telegram bot configured — chat ID `<value>` saved.
> Cron skill placeholders updated in workspace/skills/*.md.

## Rules

- The chat ID is not secret, but don't commit workspace files to the main repo.

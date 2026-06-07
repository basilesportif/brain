# To-Do Skill

> All `workspace/` references below resolve to the active assistant workspace.
> Brain integration: run these commands through `pnpm run brainctl workspace run --path <workspace> <script>.js -- <args>` from the Brain checkout. Historical `node scripts/...` examples below map to compiled native CLI commands under `packages/assistant-logic/dist/cli/`.

## Usage

Use this skill when the user wants to add, list, or delete personal to-dos.

To-dos are stored in `workspace/data/todos.json` (created lazily on first add). This is lightweight personal task tracking — not calendar events, reminders, or project issue tracking.

## Commands

All commands output JSON to stdout. Run them from the Brain checkout through `brainctl workspace run`.

### Add a to-do

```bash
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-add.js -- --title "Buy coffee" --description "Whole beans from the roaster"
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-add.js -- --title "Call dentist"
```

### List to-dos

```bash
# All to-dos
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-list.js --

# Filter by substring (case-insensitive, matches title and description)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-list.js -- --query "coffee"
```

### Delete a to-do

```bash
# By exact ID (preferred)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-delete.js -- --id "td_abc123"

# By title match (deletes if exactly one match)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-delete.js -- --title "coffee"

# By user-visible list number (maps internally; do not show td_* to the user)
pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-delete.js -- --number 2
```

If `--title` matches multiple to-dos, the script exits with code 2 and lists the matches on stderr. Use `--id` internally to disambiguate, or `--number` for a user-visible numbered-list reference.

## Post-Mutation Rule

**MANDATORY: After EVERY add or delete — no matter how small — you MUST:**
1. Run `pnpm run brainctl workspace run --path "$ASSISTANT_WORKSPACE" todo-list.js --`
2. Include the full numbered list in the Telegram reply (or terminal response)

This is non-negotiable. Do NOT send any reply without the updated list attached. Skipping this step is a bug.

## Routing

All to-do operations (add, list, delete) should run directly in the main session — do **not** dispatch a sub-agent. Use **Sonnet medium** effort. To-do operations are fast, deterministic, and don't benefit from backgrounding.

## Interaction Rules

See `workspace/instructions/skills/todo.md` for response formatting, listing style, and post-mutation display rules.

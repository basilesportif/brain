# Setup Skill

This is the entry point for workspace setup and migration.

## Workspace Model

- Single active workspace, resolved in this order:
  1. `ASSISTANT_WORKSPACE`
  2. `ASSISTANT_HOME/workspace` or `ASSISTANT_CONTAINER_ROOT/workspace`
  3. `ASSISTANT_CLAUDE_ROOT/workspace`
  4. Legacy default `~/.assistant-claude/workspace/`
- `workspace/` in the repo is a convenience symlink to the resolved workspace.
- Scheduled tasks must set `ASSISTANT_WORKSPACE` explicitly.

## Step 0: Preflight

1. Resolve the workspace path with `node -e 'process.stdout.write(require("./scripts/lib/workspace").getCurrentWorkspacePath({ mustExist: false }))'`.
2. Check if the resolved workspace exists and looks valid (has `data/`, `.env`, etc.).
3. If a legacy multi-workspace layout is detected (`<assistant container>/workspaces/<slug>/`), run the migration:

```bash
node scripts/setup/migrate-to-single-workspace.js
```

Use `--dry-run` first when changing `ASSISTANT_WORKSPACE`, `ASSISTANT_HOME`, or `ASSISTANT_CONTAINER_ROOT`.

4. If no workspace exists at all, create one from the template.

## Step 1: Ensure Workspace Exists

1. Create the resolved workspace path if it doesn't exist.
2. Copy template files from `config/workspace-template/` (don't overwrite existing files).
3. Ensure required directories exist: `data/`, `tasks/`, `skills/`, `instructions/`.
4. Ensure `.gitignore` includes `.env` and `data/*.json`.
5. Ensure `.env` exists (copy from template `.env.example` if missing).
6. Initialize a git repo if `.git/` doesn't exist.

## Step 2: Ensure Symlink

1. Ensure `workspace` symlink in the repo points to the resolved workspace path.
2. If the symlink exists but points elsewhere, update it.
3. If a non-symlink `workspace` path exists, error and ask the user to resolve manually.

## Step 3: Secrets Bootstrap

1. Ensure `<workspace>/.env` exists.
2. Explain:
   - workspace `.env` is the place for `COMPOSIO_API_KEY`, `GH_TOKEN`
   - `TELEGRAM_BOT_TOKEN` lives at `~/.claude/channels/telegram/.env` (stock plugin location)
   - process env may override for a single command

## Step 4: Integrations

Ask which integrations to configure:

- Composio (Gmail/Calendar)
- GitHub
- Telegram Bot (notifications)
- Telegram Messages (inbox reading)
- Repo Registry (multi-repo orchestration)

For each selected integration, follow the corresponding setup skill:

| Selection | Skill file |
|-----------|-----------|
| Composio | `config/skills/setup-composio.md` |
| GitHub | `config/skills/setup-github.md` |
| Telegram Bot | `config/skills/setup-telegram-bot.md` |
| Telegram Messages | `config/skills/setup-telegram.md` |
| Repo Registry | `config/skills/setup-repo-registry.md` |

Rules:

- Secrets must be read from and written to `<workspace>/.env`.
- Generated config files must be written under the resolved workspace.

## Step 5: Scheduled Task Format

Scheduled tasks must target both this repo clone and the workspace explicitly.

Required command shape:

```bash
cd /abs/path/to/assistant-agent-logic && ASSISTANT_WORKSPACE=/abs/path/to/workspace <task command>
```

## Step 5A: Workspace Instruction Overlays

The template includes `workspace/instructions/`:

- `workspace/instructions/skills/*.md` for user-specific overlays on shared repo skills
- `workspace/instructions/prompts/*.md` for user-specific overlays on shared repo prompts

These are additive only and must not redefine commands, storage, or safety rules.

## Step 6: Summary

Print:

- workspace path: resolved workspace path
- symlink status
- whether migration happened
- where secrets live
- scheduled task status

## Step 7: Start Loops

After setup is complete, remind the user:

> Run **"start loops"** to activate persistent loops defined in `workspace/tasks/loops.json`. See `config/skills/loops.md`.

## Invariants

After `/setup`, all of these must be true:

- the resolved workspace exists
- `workspace/` symlink points to the resolved workspace
- the workspace has `.env`
- the workspace `.gitignore` ignores `.env`

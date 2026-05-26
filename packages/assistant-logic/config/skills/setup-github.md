# Setup GitHub Skill

Guides the user through creating and storing a GitHub personal access token.

## Pre-check

Check if `workspace/.env` or the shell has a non-empty `GH_TOKEN`.

If it does, print:
> GitHub token is already configured.

Then stop.

## Step 1: Create token

Tell the user:
> You need a GitHub personal access token:
> 1. Go to https://github.com/settings/tokens
> 2. Click "Generate new token" → "Generate new token (classic)"
> 3. Give it a name (e.g., "assistant-claude")
> 4. Select the `repo` scope (full control of private repositories)
> 5. Click "Generate token" and copy it

## Step 2: Store token

Prompt for the token via AskUserQuestion.

Write/append `GH_TOKEN=<value>` to `workspace/.env`. If it exists, add the line or replace an existing empty `GH_TOKEN=` line. If it doesn't exist, create it from `config/workspace-template/.env.example`.

Print:
> GitHub token saved to `workspace/.env`. You can now use GitHub features.

## Rules

- Never log the token in output — only confirm it was saved.
- `workspace/.env` is gitignored — never commit it.

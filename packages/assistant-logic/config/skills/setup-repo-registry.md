# Setup Repo Registry Skill

Sets up the repo-registry controller runtime for multi-repo orchestration inside the selected workspace.

## Pre-check

Check if `workspace/.claude/repo-registry/runtime/dist/bootstrap.js` exists.

If it does, print:
> Repo registry is already configured — runtime is installed.

Then stop.

## Step 1: Verify Codex CLI

Check if `codex` is available:
```bash
codex --version
```

**If installed**, skip to Step 2:
> Codex CLI found — skipping installation.

**If not installed:**
Tell the user:
> You need the Codex CLI installed:
> ```
> npm install -g @openai/codex
> ```
> Then authenticate:
> ```
> ! codex login
> ```
> This opens a browser for ChatGPT OAuth. No API key needed.

Wait for the user to confirm.

## Step 2: Verify Codex auth

Check if `~/.codex/auth.json` exists and has valid tokens.

**If authenticated**, skip to Step 3:
> Codex is authenticated — skipping login.

**If not authenticated:**
Tell the user:
> You need to log in to Codex:
> ```
> ! codex login
> ```
> This will open a browser window for ChatGPT OAuth.

Wait for the user to confirm.

## Step 3: Install runtime

Run:
```bash
ASSISTANT_WORKSPACE="$(node -e 'process.stdout.write(require("./scripts/lib/workspace").getCurrentWorkspacePath({ mustExist: false }))')" node config/skills/repo-registry/scripts/install-runtime.mjs
```

This copies the bundled runtime, runs npm install, builds, and bootstraps.

## Step 4: Verify

Check that `workspace/.claude/repo-registry/runtime/dist/bootstrap.js` exists.

Print:
> Repo registry installed. Register repos with aliases to start using multi-repo orchestration.

## Rules

- No API keys are needed — Codex uses local ChatGPT OAuth auth.
- The runtime is installed under `workspace/.claude/repo-registry/runtime/`.

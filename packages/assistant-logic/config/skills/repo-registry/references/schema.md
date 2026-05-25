# Repo Registry Schema

This skill uses a workspace-canonical state model under `<resolved workspace>/.claude/repo-registry/`. With no env/config the resolved workspace remains the legacy `~/.assistant-claude/workspace/`; generic deployments can set `ASSISTANT_WORKSPACE`, `ASSISTANT_HOME`, or `ASSISTANT_CONTAINER_ROOT`.

## `index.yaml`

```yaml
version: 1
controller_root: /Users/example/.assistant-claude/workspace
repos:
  alias-name:
    alias: alias-name
    path: /absolute/path/to/repo
    repo_name: repo
    default_branch: main
    current_branch: feature-branch
    remote_url: git@github.com:owner/repo.git
    preferred_engine: claude
    codex_model: gpt-5.4
    codex_effort: xhigh
    repo_manifest_path: /absolute/path/to/repo/.claude/repo-registry/manifest.yaml
    latest_plan: null
    latest_review: null
    latest_pr: null
    deploy_host: tim-apps
    deploy_path: /root/pkg/repo
    domain: repo.example.com
    registered_at: 2026-03-21T12:00:00.000Z
    updated_at: 2026-03-21T12:00:00.000Z
```

## `config.yaml`

```yaml
version: 1
default_engine: claude
default_codex_model: gpt-5.5
default_codex_effort: xhigh
```

`default_codex_model` and `default_codex_effort` are used for Codex-backed repo edits when the repo does not set `codex_model` / `codex_effort` explicitly.

## `repos/<alias>/state.yaml`

```yaml
version: 1
alias: alias-name
controller_root: /Users/example/.assistant-claude/workspace
repo_root: /absolute/path/to/repo
repo_manifest_path: /absolute/path/to/repo/.claude/repo-registry/manifest.yaml
notes_path: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/notes.md
guidance_path: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/guidance.md
guidance_json_path: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/guidance.json
artifacts_dir: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/artifacts
sessions_dir: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/sessions
active_plan_session_path: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/sessions/feature_upgrade.yaml
deployment_host: tim-apps
deployment_path: /root/pkg/repo
domain: repo.example.com
preferred_engine: claude
codex:
  model: null
  effort: null
latest:
  plan: null
  review: null
  pr: null
registered_at: 2026-03-21T12:00:00.000Z
updated_at: 2026-03-21T12:00:00.000Z
```

## `repos/<alias>/guidance.json`

```yaml
alias: alias-name
repo_root: /absolute/path/to/repo
host: local
deployment_host: tim-apps
deployment_path: /root/pkg/repo
domain: repo.example.com
has_agents: true
files:
  - path: AGENTS.md
    reason: root-default
    exists: true
  - path: README.md
    reason: root-default
    exists: true
skill_directories:
  - path: skills
    entries:
      - skills/deploy/SKILL.md
```

## Repo-local `manifest.yaml`

```yaml
version: 1
alias: alias-name
controller_root: /Users/example/.assistant-claude/workspace
repo_root: /absolute/path/to/repo
controller_state_path: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/state.yaml
```

## `repos/<alias>/sessions/<slug>.yaml`

```yaml
version: 1
alias: alias-name
title: Feature Upgrade
plan_slug: feature_upgrade
plan_artifact_path: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/artifacts/PLAN_feature_upgrade.md
status: open
backend: codex
codex_thread_id: thread_123
last_prompt_path: /Users/example/.assistant-claude/workspace/.claude/repo-registry/repos/alias-name/artifacts/PLAN_feature_upgrade.prompt.md
last_response_summary: Initial Codex plan returned two decision points.
open_decisions:
  - Pick rollout order
  - Pick migration timing
created_at: 2026-03-21T12:00:00.000Z
updated_at: 2026-03-21T12:05:00.000Z
```

## Active plan artifact convention

Planning conversations should treat the current `PLAN_<slug>.md` as a working document, not a one-shot output.

Recommended structure:

```md
# PLAN feature-upgrade

## Goal
- Short restatement of the user's objective.

## Current Recommendation
- Claude's current best read of Codex's recommendation.

## Open Questions
- Decision 1
- Decision 2

## Decision Log
- 2026-03-21: User chose option 2 for rollout because the migration risk was acceptable.

## Locked Plan
- Empty until the user approves the final direction.

## Execution Handoff
- Backend to use
- Repo alias
- Artifact or branch expectations
```

Keep repo-wide enduring facts in `notes.md`. Keep plan-specific tradeoffs and user decisions in the active `PLAN_<slug>.md`.

Keep thread/session metadata in `sessions/<slug>.yaml`. That file is controller-side orchestration state, not repo content.

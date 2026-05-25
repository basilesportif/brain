---
name: repo-registry
description: Use when Claude Code needs to register or coordinate multiple local or remote git repos by alias, run an interactive planning loop with Codex while tracking decisions, collect repo guidance such as AGENTS.md, and execute plan, review, or PR handoffs. Supports dispatching work to remote dev servers over SSH.
---

# repo-registry

Use this skill when the user treats Claude as a controller over multiple local or remote repos and wants Claude to curate the planning dialogue while Codex or Claude performs repo-aware work. Remote repos are managed over SSH — the registry tracks which host each repo lives on.

This skill is a text-backed repo registry, not a scheduler. Canonical state lives in the selected workspace under `workspace/.claude/repo-registry/`. Managed repos only get thin `.claude/repo-registry/` marker files and JS launchers.

Planning thread state belongs in the controller repo, not inside the target repo. Use:

- `repos/<alias>/artifacts/PLAN_<slug>.md` for the living plan document
- `repos/<alias>/sessions/<slug>.yaml` for Codex thread and session metadata
- `repos/<alias>/state.yaml` for the repo's current active plan session pointer

## Trigger cases

Use this skill when the user asks to:

- register or attach a repo by alias
- point Claude at another local repo and keep working context for it
- list repos, check repo status, or ask "what repos do I have"
- check git status across all repos ("are any repos dirty?", "what needs pushing?")
- make a plan in a repo before coding
- ask Codex for a repo-aware plan, then discuss tradeoffs before execution
- review or prepare a PR draft for a repo that is not the current `cwd`
- maintain a persistent decision log while a plan is being refined

## Listing repos

**Canonical source**: The full list of registered repos lives in `<resolved workspace>/.claude/repo-registry/index.yaml` under the top-level `repos:` map. This is the ONLY authoritative source for "what repos are registered" / "repo registry status" queries. Read that file directly with the Read tool.

Do NOT infer the repo list by listing `<resolved workspace>/.claude/repo-registry/repos/` — that directory only contains per-repo planning artifacts (state, notes, sessions, artifacts) for repos that have had planning activity, and is not a complete or authoritative enumeration of registered repos. Many registered repos will have no entry there at all.

When the user asks about the state of their repos, what's in the registry, or similar, read `<resolved workspace>/.claude/repo-registry/index.yaml` and **query live git status** for each repo under its `repos:` map, then present each repo with:

- **Alias** — the short name used to reference the repo
- **Host** — `local` (on this machine) or the SSH address for remote repos
- **Path** — where the repo lives on that host
- **Remote URL** — the GitHub remote (if set)
- **Branch** — current branch
- **Git status** — clean, dirty (uncommitted changes), or ahead/behind remote (needs push/pull)
- **Engine** — preferred engine (codex or claude)
- **Latest plan** — if any active plan exists

Group repos by host for clarity. Include the dev server label from `dev_servers` config if applicable.

### Querying git status

To get live git status for a repo, run the appropriate command based on host:

```bash
# Local repo
cd <path> && git status --porcelain && git rev-list --left-right --count HEAD...@{upstream}

# Remote repo
ssh <host> "cd <path> && git status --porcelain && git rev-list --left-right --count HEAD...@{upstream}"
```

The `--porcelain` output tells you if the working tree is dirty (any output = dirty, no output = clean). The `rev-list --left-right --count` gives `<ahead>\t<behind>` relative to the upstream branch.

When the user asks to check git status across all repos, run these commands in parallel (one per repo) and present a summary table:

```text
Repo              Host     Branch   Status
assistant-logic   local    main     clean, up to date
api-service       dev      main     2 uncommitted changes, 1 ahead
load-balancer     dev      main     clean, 3 behind
```

Highlight repos that need attention (dirty or ahead/behind) so the user can act on them quickly.

## Claude's role

Claude is the conversational and product-level orchestration layer.

- Claude interprets the user's goal, constraints, and preferences.
- Codex or Claude handles repo-aware planning and execution.
- Claude translates dense planning output into explicit decision points.
- Claude flags assumptions that the user has not yet approved.
- Claude maintains a running decision log so follow-up rounds stay grounded.

## Canonical workflow

1. Ensure the controller runtime exists. If it is missing, install it from this skill on first use.
2. Register repos by alias from `cwd` or an explicit path.
3. Resolve an alias to a repo when the user asks for planning, review, PR, or execution work.
4. Collect repo guidance before every planning or execution handoff.
5. If the task is exploratory, run a planning loop before execution.
6. Persist the active plan, decisions, planning-session metadata, and final artifacts under the controller repo.

## Planning orchestration loop

For planning-heavy work, default to this loop instead of executing immediately:

1. Resolve or register the repo alias.
2. Run `collect-guidance` so the backend sees the target repo's `AGENTS.md`, root docs, and local skill inventory.
3. Create or refresh the active plan artifact with `run-handoff --action plan --preview-only`.
4. Create or refresh `sessions/<slug>.yaml` for the active plan.
5. Send the planning prompt to Codex, preferably on the same SDK thread for follow-up rounds.
6. Read Codex's output and reduce it to:
   - recommended direction
   - open decisions
   - tradeoffs
   - assumptions that need approval
7. Present only the decisions the user actually needs to make.
8. Append the user's answers to the active plan artifact's decision log.
9. Update `sessions/<slug>.yaml` with the current thread ID, response summary, and remaining open decisions.
10. Continue the same planning thread until the plan is locked.
11. Only then hand the locked plan to the selected execution backend.

If a threaded Codex session is not available, emulate continuity by sending the current plan artifact, the decision log, and the latest user answers back with the next prompt.

Do not skip straight to execution unless:

- the user explicitly asks to execute now
- the task is a direct review request
- the plan is already locked in the active artifact

## Project classification

Project ownership, account conventions, and default local or remote repo roots are workspace-specific preferences. Read `workspace/instructions/skills/repo-registry.md` when it exists. If no overlay or registry config states the default ownership, ask the user before classifying a repo or choosing account-specific paths.

Do not infer project ownership from infrastructure, deployment hosts, prior work, or shared tooling unless the workspace overlay explicitly says to do so.

## Decision presentation pattern

After each Codex planning round, Claude should present decisions in a tight structure instead of dumping raw output. Use a format like:

```text
Recommendation
- Adopt option A because it minimizes repo churn and keeps rollout reversible.

Decision needed
- Deployment path

Options
1. Keep the current deploy surface and patch it in place.
2. Introduce a new deploy path with a migration step.

Tradeoffs
- Option 1 is faster but preserves existing complexity.
- Option 2 is cleaner long term but increases rollout risk.

Needed from user
- Choose 1 or 2.
```

Keep the number of open decisions low. Bundle only mutually dependent questions together.

## Working plan and decision log

Treat the active `PLAN_<slug>.md` as a living planning dossier during the conversation.

Keep these sections current:

- `## Goal`
- `## Current Recommendation`
- `## Open Questions`
- `## Decision Log`
- `## Locked Plan`
- `## Execution Handoff`

Use `notes.md` only for durable repo-level facts that should survive across multiple planning efforts. Keep transient plan negotiations inside the current plan artifact.

Treat `sessions/<slug>.yaml` as the machine-readable companion to that plan:

- `codex_thread_id` binds follow-up rounds to the same Codex thread
- `status` tracks `open`, `locked`, `executing`, or `done`
- `last_response_summary` gives Claude a quick reload point after compaction
- `open_decisions` records the decisions still waiting on the user

## Runtime location

The reusable source lives in this skill package. The installed runtime lives under:

```text
workspace/.claude/repo-registry/runtime/
```

First-use bootstrap rule:

- Check for `workspace/.claude/repo-registry/runtime/dist/bootstrap.js`.
- If it is missing, run the bundled installer from the installed skill directory:

```bash
node scripts/install-runtime.mjs
```

- After that, continue with the requested repo-registry task.

The installer copies the bundled runtime into the controller repo, runs `npm install`, runs `npm run build`, and then runs the runtime bootstrap entrypoint.

Manual equivalent:

```bash
cd workspace/.claude/repo-registry/runtime
npm install
npm run build
```

If you need to target a non-default controller root, use:

```bash
node scripts/install-runtime.mjs --controller-root /absolute/path/to/workspace
```

For validation or debugging, the installer also supports:

- `--skip-install`
- `--skip-build`
- `--skip-bootstrap`

## Registry commands

From the controller runtime:

```bash
node dist/bootstrap.js
node dist/register-repo.js --alias repo-name --cwd
node dist/register-repo.js --alias repo-name --path /absolute/path/to/repo
node dist/resolve-repo.js --alias repo-name --json
node dist/collect-guidance.js --alias repo-name
node dist/run-handoff.js --alias repo-name --action plan --engine claude --title "work item"
node dist/run-handoff.js --alias repo-name --action review --engine codex --title "branch review"
node dist/run-handoff.js --alias repo-name --action plan --engine codex --title "preview only" --preview-only
node dist/run-handoff.js --alias repo-name --action plan --engine codex --title "feature upgrade" --codex-thread-id thread_123 --open-decision "Choose rollout path"
```

Aliases are required. Keep them short and stable.

From the installed skill directory:

```bash
node scripts/install-runtime.mjs
```

## Guidance ingestion

Never assume Codex or another backend will auto-discover repo guidance. The runtime must collect it explicitly before every handoff.

`collect-guidance` must gather:

- root `AGENTS.md` in full when present
- root `README.md`
- root `SETUP.md`
- root `SKILLS_INDEX.md`
- relative file paths explicitly referenced in `AGENTS.md`
- inventories for `skills/`, `.agents/skills/`, and `.claude/skills/`

Do not recursively inline every skill body from those directories. Record the available `SKILL.md` paths instead.

If `AGENTS.md` is missing, continue and record that clearly in the generated guidance bundle.

## Handoff behavior

Supported actions:

- `plan`
- `review`
- `pr`

Supported engines:

- `claude`
- `codex`

Artifacts are written under the controller repo, not the managed repo:

- `PLAN_<slug>.md`
- `REVIEW_<slug>.md`
- `PR_<slug>.md`

`pr` means "prepare PR draft and checklist". It does not push branches or open a remote PR.

For planning conversations, `run-handoff --action plan --preview-only` is the normal starting point. It allocates the artifact path, prompt bundle, and planning session file without forcing immediate backend execution.

For `plan` actions, `run-handoff` also maintains `sessions/<slug>.yaml`. Use these optional flags when real session metadata is available:

- `--codex-thread-id <thread-id>`
- `--session-status open|locked|executing|done`
- `--response-summary <text>` or `--response-summary-file <path>`
- `--open-decision <text>` repeated as needed

## Claude backend

**Always run Claude handoffs in a background sub-agent** (`run_in_background: true`). Planning loops involve multiple tool calls and should not block the main session.

**Claude runs on the machine where the repo lives**, same as Codex. Check the repo's `host` field:

- `host: local` (or absent) → `cd` into the repo and work directly.
- `host: user@ip` → execute via SSH: `ssh <host> "cd <path> && claude --print '<prompt>'"`.

For a Claude handoff:

1. Run `collect-guidance` (locally for local repos, via SSH for remote repos).
2. Resolve or create the active artifact path.
3. Read the generated `guidance.md`.
4. Execute work on the repo's host machine (locally or via SSH).
5. Curate the planning dialogue or perform the requested handoff.
6. Write back the updated plan, decision log, or final artifact to the controller path returned by `run-handoff`.

Use the generated prompt bundle from `run-handoff` rather than reconstructing the context ad hoc.

Pass `--preview-only` when the user wants the artifact path and prompt bundle prepared without triggering a Codex run yet.

## Codex backend

**Always run Codex handoffs in a background sub-agent** (`run_in_background: true`). Codex calls take 30+ seconds and must not block the main session. Send the ack first, dispatch the agent, report results when it completes.

**Codex runs on the machine where the repo lives.** This is a hard rule. Check the repo's `host` field in the registry:

- `host: local` (or absent) → run Codex directly on this machine.
- `host: user@ip` → run Codex over SSH on that host.

Never run Codex on a different machine from the repo. A local repo's Codex runs locally even if a dev server also has a copy of the repo.

Codex dispatches use the `codex` CLI binary directly (no per-repo `node_modules`, no `@openai/codex-sdk`). Auth uses the local Codex CLI credentials (`~/.codex/auth.json`, ChatGPT OAuth) on whichever machine runs the command — local for `host: local`, the dev server for SSH targets.

### CLI invocation pattern

The controller runtime (`runCodexSdk` in `dist/run-codex-sdk.js`, name kept for backwards compatibility) builds and runs the CLI directly.

For **local repos**, the prompt is streamed in via stdin and the artifact is written by Codex itself via `-o`:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  -m <model> \
  --add-dir <artifact-dir> \
  -o <artifact-path> \
  - < <prompt-file>
```

For **remote repos**, the controller scp's the prompt to `/tmp/codex-prompt-<uuid>` on the remote host, runs `codex exec` there with `-o /tmp/codex-artifact-<uuid>`, scp's the artifact back, and removes the tmp files:

```bash
scp <prompt-file> <host>:/tmp/codex-prompt-<uuid>
ssh <host> "cd <repo-path> && codex exec --dangerously-bypass-approvals-and-sandbox \
  -m <model> -o /tmp/codex-artifact-<uuid> - < /tmp/codex-prompt-<uuid>"
scp <host>:/tmp/codex-artifact-<uuid> <local-artifact-path>
ssh <host> "rm /tmp/codex-prompt-<uuid> /tmp/codex-artifact-<uuid>"
```

If `codex_effort` is set on the repo state, it is passed as `-c model_reasoning_effort=<value>`. If not, the registry-level `default_codex_effort` is used.

### Pre-dispatch availability check

Before any Codex dispatch the runtime runs `ensureCodexCliAvailable()`, which calls `which codex` and aborts with an actionable error if the binary is missing. Install with `npm install -g @openai/codex` (or your platform's package) on the host that owns the repo.

When Codex is used for planning:

- prefer a single thread per active planning artifact
- send follow-up user decisions back into the same thread
- keep Claude responsible for summarizing the resulting tradeoffs and asking the next focused question
- only switch from planning to execution after the user approves the locked plan

When Codex is used for execution, send the locked plan plus the guidance bundle instead of the raw conversation transcript.

## Managed repo files

Each managed repo gets a single breadcrumb file:

```text
.claude/repo-registry/manifest.yaml
```

That file points back at the controller repo's state for the alias. The source of truth remains the controller repo. No `node_modules`, `package.json`, or per-repo launchers — the controller invokes the `codex` CLI directly (locally or via SSH).

## Remote dev servers

Repos can live on a remote development server instead of the local machine. The registry tracks this via:

- A top-level `dev_servers` map in `index.yaml` defining named server configs
- A `host` field on each repo entry (`local` or a `user@ip` SSH target)

### index.yaml structure

```yaml
dev_servers:
  dev:
    host: dev@example.com
    default_repo_root: ~/pkg/org

repos:
  my-repo:
    alias: my-repo
    host: dev@example.com         # remote — matches a dev_servers entry
    path: ~/pkg/org/my-repo       # path on the REMOTE machine
    ...
  brain:
    alias: brain
    host: local                    # default — repo is on this machine
    path: /home/user/pkg/brain
    ...
```

### Determining if a repo is remote

A repo is remote when its `host` field is anything other than `local` (or absent). When `host` is present and not `local`, all filesystem and git operations for that repo go through SSH.

### SSH command patterns

All commands targeting a remote repo use this format:

```bash
# Run a command on the remote server
ssh <host> "<command>"

# Clone a repo
ssh dev@example.com "git clone git@github.com:org/repo.git ~/pkg/org/repo-name"

# Git operations
ssh dev@example.com "cd ~/pkg/org/repo-name && git status"
ssh dev@example.com "cd ~/pkg/org/repo-name && git pull"
ssh dev@example.com "cd ~/pkg/org/repo-name && git checkout -b feature-branch"

# Read a file
ssh dev@example.com "cat ~/pkg/org/repo-name/package.json"

# Run Claude Code / Codex on the remote server
ssh dev@example.com "cd ~/pkg/org/repo-name && claude --print 'describe this repo'"
ssh dev@example.com "cd ~/pkg/org/repo-name && codex exec -m gpt-5.5 -c model_reasoning_effort=xhigh 'implement the feature'"

# Run npm/node commands
ssh dev@example.com "cd ~/pkg/org/repo-name && npm install"
ssh dev@example.com "cd ~/pkg/org/repo-name && npm test"
```

For long-running commands, use `run_in_background: true` on the Bash tool call as usual.

### SSH requirements

- The assistant machine must have passwordless SSH access to the remote host (key-based auth, no passphrase prompt).
- The remote server must have: Git, Node.js, npm, and SSH keys registered with GitHub.
- The remote server should have Claude Code and/or Codex CLI installed if those engines are used.

### Registering a remote repo

Remote repos cannot use the `register-repo.js` runtime command (which inspects the local filesystem). Instead, register them by editing `index.yaml` directly:

1. Add or verify the server in `dev_servers`.
2. Add the repo entry under `repos` with `host` set to the SSH target.
3. Set `path` to the repo path on the remote machine.
4. Verify connectivity: `ssh <host> "cd <path> && git status"`.

### Guidance collection for remote repos

When collecting guidance for a remote repo, read the relevant files over SSH:

```bash
ssh dev@example.com "cat ~/pkg/org/repo-name/AGENTS.md"
ssh dev@example.com "cat ~/pkg/org/repo-name/README.md"
ssh dev@example.com "ls ~/pkg/org/repo-name/skills/ 2>/dev/null"
```

Store the collected guidance locally in the controller repo as usual.

### Claude/Codex handoffs for remote repos

Both Claude and Codex must run on the remote host where the repo lives. Never run them locally against a remote repo's files.

For Claude backend handoffs on a remote repo:

1. Collect guidance via SSH (see above).
2. Store the plan artifact locally in the controller repo.
3. Execute work via SSH: `ssh <host> "cd <path> && claude --print '<prompt>'"`.
4. Read results via SSH and update the local plan artifact.

For Codex backend handoffs on a remote repo:

1. Collect guidance via SSH.
2. Store the plan artifact locally in the controller repo.
3. Execute via SSH: `ssh <host> "cd <path> && codex exec -m <model> -c model_reasoning_effort=<effort> '<prompt>'"`.
4. Read results via SSH and update the local plan artifact.

For local repos (`host: local`), run Claude and Codex directly on this machine — do not route through SSH even if a dev server has a copy of the same repo.

## Safety rules

- Refuse to register a non-git directory.
- Refuse alias collisions.
- Prefer explicit alias use over guessing from repo name.
- Ask the user before registering a new repo or installing the Codex SDK into a repo if that action was not already clearly requested.
- When a prompt names a repo ambiguously, resolve it before continuing.
- When Codex proposes assumptions the user has not approved, surface them as explicit decisions instead of silently accepting them.
- Do not start execution work from a planning conversation until the plan is locked or the user explicitly says to proceed.

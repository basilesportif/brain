# Deployment planning

No live deployment is executed by this repository by default. Brain is the
control plane for reviewed setup/deploy planning. The production servant runtime
is `codex-chat`; `assistant-agent-logic` and `assistant-agent-data` stay as
separate repositories/workspaces. Brain's own runtime service remains
experimental/lab until deliberately promoted.

For abstract/new Brain deployments, `brainctl stack status` and `brainctl stack
plan` are setup/planning tools. They read repo-registry metadata plus ignored
setup context, render no-network plans, and refuse repo-boundary violations
before any executor can act. For a running Brain instance, repo-registry metadata
is not the source of truth: the concrete Brain web service owns its own
env/settings for where `codex-chat`, `assistant-agent-logic`, workspaces, env
files, and systemd services are deployed. Deployment status itself is recorded
on the Brain/control-plane host, not in the local repo registry:

```text
<brain-workspace-root>/state/control-plane/deployments.json
```

For a conventional remote Brain target that may be:

```text
/home/brain/.brain/workspace/state/control-plane/deployments.json
```

For this local Brain instance, the admin service runs beside the active
`codex-chat.service` on `codex-chat-assistant-1` (`178.104.208.141`) and should
report/control the local paths:

```text
/home/tim/pkg/tim/brain
/home/tim/pkg/tim/codex-chat
/home/tim/pkg/tim/assistant-agent-logic
/home/tim/.assistant-claude/workspace
/home/tim/.config/codex-chat/env
/home/tim/pkg/tim/codex-chat/config/codex-chat.toml
codex-chat.service
```

Local notes and registry entries may point at historical or planned deployments,
but the concrete Brain instance settings and private deployment ledger are
canonical for that instance.


## Canonical setup UX

For a first install, clone/open the Brain repo root in Codex or Claude Code and
say `setup`. The agent should remain at the repository root, read the root agent
guidance plus `docs/setup-plan.md` and
`assistant-packs/core/skills/setup-self-host/SKILL.md`, ask local vs remote, and
continue with the appropriate local workspace or remote SSH flow. Do not ask the
user to enter a separate setup directory.

Deployment docs and private notes should define:

- Supported self-host target OS and prerequisites.
- Local SSH config conventions for remote setup.
- Dedicated service user creation on remote hosts.
- Node/pnpm and optional Bun/Docker requirements.
- Provider auth boundaries for Codex provider/app-server and Claude Code
  SDK/subagents.
- Telegram first-entrypoint bootstrap, bot token storage, and capped first-user admin pairing.
- Process manager choice (`systemd`, Docker, or both).
- Reverse proxy/TLS and firewall recommendations. Polling-mode Telegram needs
  outbound HTTPS only; webhook or web preview needs inbound HTTPS.
- Secret storage and rotation expectations.
- Health checks, logs, backups, updates, and rollback commands.
- Clear distinction between development checkout, deployment checkout, and
  private workspace/data volumes.

Initial bootstrap must not require Composio or any optional integration. Those
can be configured later after Telegram admin pairing is working.

## Current Brain instance target

Brain is an abstract project, but this running Brain instance is local to the
active codex-chat server. Its source-of-truth settings live in the
`brain-admin.service` environment (`~/.config/brain-admin/env`) and defaults,
not in the repo registry. The admin service should show/control local
`codex-chat.service` on this server and should not redirect operators toward
retired remote deploy targets.

Historical Brain/Anna SSH metadata was retired on 2026-06-25 because that server
is no longer used. Do not run status, deploy, health-check, or smoke-test
commands against old Brain/Anna hostnames or IPs from historical notes. For any
future remote setup, collect or confirm a fresh SSH target first.

`brain-personal.service` remains a legacy Brain lab runtime target and must not
be enabled as a live Telegram poller unless an explicit offline lab smoke test
requires it.

## Current safe operations seams

The repository now has CLI seams for deployment automation, but they remain
non-deploying by default:

- `brainctl stack status` resolves the `codex-chat` servant runtime,
  `assistant-agent-logic`, `assistant-agent-data`/workspace, deploy host, SSH
  identity, service/env/config paths, deployment metadata path/status, and
  health checks from repo registry and setup context without contacting hosts.
- `brainctl stack plan` renders the no-network servant stack flow: clone/update
  separate repos, install `codex-chat` dependencies/build, install
  `assistant-agent-logic` dependencies with the correct lockfile/package
  manager, verify its Composio workflow modules load, prompt/validate assistant
  data, render `codex-chat` config/env, plan Telegram pairing/admin state
  preservation, plan service install/start, record deployment metadata, and plan
  health checks. It does not execute SSH, git, systemd, or secret reads.
- `brainctl stack apply` is the explicit approval boundary. Without `--approve`
  it is a dry-run. With `--approve` and an executor, it fetches/clones the
  configured latest refs for `codex-chat` and `assistant-agent-logic`, verifies
  resolved SHAs, then can run approved dependency install/build, Composio module
  verification, and metadata steps.
  `--approve-data`, `--approve-config`,
  `--approve-service`, and `--approve-health` separately gate assistant data
  actions, config/env template writes, Telegram pairing/admin state migration
  plus systemd install/start, and live/read-only health checks. The migration
  step merges legacy `state/telegram-pairing` identities into
  `state/codex-chat`, backs up existing files, removes stale bootstrap pairing
  codes once identities exist, and prints metadata only (never raw Telegram IDs).
  Use `--executor mock --metadata-file <path>` for tests and rehearsals; use
  `--executor ssh` only after reviewing the rendered plan.
- `brainctl start`/`brainctl run` are lab supervisor seams only. They are not
  production deployment targets.
- `brainctl health` inspects config/state/log readiness without starting live providers or Telegram.
- `brainctl logs` tails Brain JSONL logs with redaction.
- `brainctl operations plan` renders preflight, update, restart, rollback, and post-update smoke command lists.
- `brainctl operations systemd` is deprecated/lab-only Brain supervisor
  scaffolding. It does not write `/etc/systemd/system`, call `systemctl`, or
  restart anything, and it must not be used for any production assistant.
  Production review/install goes through `brainctl stack plan/apply` and targets
  `codex-chat.service`.
- `brainctl validate live` renders a guarded Telegram/Codex readiness plan. `--run-safe` executes only no-network/no-secret checks by default.
- Runtime chat commands such as `update`, `deploy`, and `agent backend` are recognized by the supervisor command interceptor, but they only return safe status text in this parity slice. They do not pull git, rebuild, restart systemd, or mutate crontabs.
- Runtime `employees` and `employee status/start/stop/steer` commands update durable lifecycle records only; they do not start a real Employee app-server process.

To add a new deployment:

1. Add/verify repo-registry link metadata for `codex-chat`,
   `assistant-agent-logic`, and `assistant-agent-data` without adding secrets.
2. Run `pnpm run brainctl stack status --workspace <id>` and fix missing paths,
   service names, env-file paths, or repo-boundary issues.
3. Run `pnpm run brainctl stack plan --workspace <id>` and review every
   rendered command.
4. Dry-run `pnpm run brainctl stack apply --workspace <id>`; it should report
   no side effects.
5. Rehearse with `--executor mock --metadata-file <temp>` and the intended
   approval flags.
6. Only then use an approved real executor. Store actual secret values on the
   server through the chosen env/secret-store mechanism; Brain records only
   redacted secret metadata.
7. Verify `stack status` reports the canonical deployment metadata path, the
   servant stack status, and the requested refs/resolved SHAs for the live
   `codex-chat` and `assistant-agent-logic` checkouts.

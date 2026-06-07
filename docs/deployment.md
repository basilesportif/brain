# Deployment planning

No live deployment is executed by this repository by default. Brain is the
control plane for reviewed setup/deploy planning. The production servant runtime
is `codex-chat`; `assistant-agent-logic` and `assistant-agent-data` stay as
separate repositories/workspaces. Brain's own runtime service remains
experimental/lab until deliberately promoted.

`brainctl stack status` and `brainctl stack plan` are the current source of truth
for control-plane stack resolution. They read repo-registry metadata plus
ignored setup context, render no-network plans, and refuse repo-boundary
violations before any future executor can act.


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
- Telegram first-entrypoint bootstrap, bot token storage, and first-user admin pairing.
- Process manager choice (`systemd`, Docker, or both).
- Reverse proxy/TLS and firewall recommendations. Polling-mode Telegram needs
  outbound HTTPS only; webhook or web preview needs inbound HTTPS.
- Secret storage and rotation expectations.
- Health checks, logs, backups, updates, and rollback commands.
- Clear distinction between development checkout, deployment checkout, and
  private workspace/data volumes.

Initial bootstrap must not require Composio or any optional integration. Those
can be configured later after Telegram admin pairing is working.

## Current Brain SSH target

The current Brain production SSH-in identity is `brain@204.168.209.41`.
Treat `root@204.168.209.41` as bootstrap/root access only when a separate
privileged context is needed. Normal post-bootstrap setup/status/deployment
commands should use the non-root `brain` service user, with source checkout
`/home/brain/brain`, workspace parent `/home/brain/.brain`, private workspace
`/home/brain/.brain/workspace`, runtime config
`/home/brain/.brain/workspace/config/runtime.yaml`, and systemd service
`brain-personal`.

## Current safe operations seams

The repository now has CLI seams for deployment automation, but they remain non-deploying by default:

- `brainctl stack status` resolves the `codex-chat` servant runtime,
  `assistant-agent-logic`, `assistant-agent-data`/workspace, deploy host, SSH
  identity, service/env/config paths, and health checks from repo registry and
  setup context without contacting hosts.
- `brainctl stack plan` renders the no-network servant stack flow: clone/update
  separate repos, prompt/validate assistant data, render `codex-chat`
  config/env, plan service install/start, and plan health checks. It does not
  execute SSH, git, systemd, or secret reads.
- `brainctl start` prints a dry-run supervisor plan unless `--foreground` is supplied.
- `brainctl health` inspects config/state/log readiness without starting live providers or Telegram.
- `brainctl logs` tails Brain JSONL logs with redaction.
- `brainctl operations plan` renders preflight, update, restart, rollback, and post-update smoke command lists.
- `brainctl operations systemd` renders a systemd unit with explicit config,
  workspace, provider, entrypoint, state/log/artifact paths. It resolves the
  provider and primary entrypoint from runtime config, so a config declaring
  Telegram + Codex renders Telegram + Codex rather than fake. It does not write
  `/etc/systemd/system`, call `systemctl`, or restart anything.
- `brainctl validate live` renders a guarded Telegram/Codex readiness plan. `--run-safe` executes only no-network/no-secret checks by default.
- Runtime chat commands such as `update`, `deploy`, and `agent backend` are recognized by the supervisor command interceptor, but they only return safe status text in this parity slice. They do not pull git, rebuild, restart systemd, or mutate crontabs.
- Runtime `employees` and `employee status/start/stop/steer` commands update durable lifecycle records only; they do not start a real Employee app-server process.

Future deployment work should attach execution wrappers to these reviewed plans and keep secrets/env files in the private workspace or host secret store.

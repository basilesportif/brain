# Deployment planning

No live deployment is executed by this repository by default. Brain now includes non-mutating operations seams that render the commands and unit files an operator can review before installing anything.

Deployment docs and private notes should define:

- Supported self-host target OS and prerequisites.
- Local SSH config conventions for remote setup.
- Dedicated service user creation on remote hosts.
- Node/pnpm and optional Bun/Docker requirements.
- Provider auth boundaries for Codex provider/app-server and Claude Code
  SDK/subagents.
- Telegram first-entrypoint bootstrap, bot token storage, and admin pairing.
- Process manager choice (`systemd`, Docker, or both).
- Reverse proxy/TLS and firewall recommendations. Polling-mode Telegram needs
  outbound HTTPS only; webhook or web preview needs inbound HTTPS.
- Secret storage and rotation expectations.
- Health checks, logs, backups, updates, and rollback commands.
- Clear distinction between development checkout, deployment checkout, and
  private workspace/data volumes.

Initial bootstrap must not require Composio or any optional integration. Those
can be configured later after Telegram admin pairing is working.

## Current safe operations seams

The repository now has CLI seams for deployment automation, but they remain non-deploying by default:

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

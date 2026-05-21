# Deployment skeleton

No live deployment is configured in this skeleton phase.

Future deployment docs should define:

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

The repository now has CLI seams for future deployment automation, but they remain non-deploying by default:

- `brainctl start` prints a dry-run supervisor plan unless `--foreground` is supplied.
- `brainctl health` inspects config/state/log readiness without starting live providers or Telegram.
- `brainctl logs` tails Brain JSONL logs with redaction.
- Runtime chat commands such as `update`, `deploy`, `agent backend`, and `employees` are recognized by the supervisor command interceptor, but they only return safe status text in this parity slice. They do not pull git, rebuild, restart systemd, mutate crontabs, or start Employee runtimes.

Future systemd/update work should attach to these seams and keep deployment scripts outside provider/entrypoint packages.

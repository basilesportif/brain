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

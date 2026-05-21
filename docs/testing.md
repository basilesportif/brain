# Testing skeleton

Migration test layers:

- Skeleton validation for required directories and private-boundary hygiene.
- Unit tests for provider-neutral and entrypoint-neutral contracts and config parsing.
- Entrypoint protocol tests using fake inbound events/outbound actions plus Telegram adapter mappings.
- Contract tests shared by Codex and Claude Code providers.
- Integration tests using fake entrypoints, fake providers, and temporary workspaces.
- Self-host smoke tests for runtime, primary entrypoint, provider, and web startup/health checks.
- Public-readiness checks for secrets, owner-specific paths, large artifacts, and generated/private data.

# Testing skeleton

Migration test layers:

- Skeleton validation for required directories and private-boundary hygiene.
- Unit tests for provider-neutral and entrypoint-neutral contracts and config parsing.
- Entrypoint protocol tests using fake inbound events/outbound actions plus Telegram adapter mappings.
- Contract tests shared by Codex and Claude Code providers.
- Integration tests using fake entrypoints, fake providers, and temporary workspaces.
- Self-host smoke tests for runtime, primary entrypoint, provider, and web startup/health checks.
- Public-readiness checks for secrets, owner-specific paths, large artifacts, and generated/private data.

The first end-to-end runtime smoke is intentionally no-network: a fake inbound message is emitted by a fake entrypoint, processed by runtime-core through a fake provider, and dispatched back as a generic outbound action. Live Telegram and real provider credentials should only be tested after that path is green.

Operator smoke checks now include:

```bash
pnpm run brainctl runtime smoke --config examples/config/runtime.yaml --workspace personal --text ping
pnpm run brainctl run --config examples/config/runtime.yaml --workspace personal --once --fake-text "agents"
pnpm run brainctl health --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl status --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl logs --file <runtime-jsonl-log> --lines 50
pnpm run brainctl provider smoke codex --transport stub --prompt ping
pnpm run brainctl operations plan --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl operations validate --config examples/config/runtime.yaml --workspace personal
pnpm run brainctl automation monitor <monitor-id> --file examples/config/automation.yaml
pnpm run brainctl web validate --dir <static-page-dir>
pnpm run brainctl validate live --config examples/config/runtime.yaml --workspace personal --run-safe
pnpm run brainctl directives check <file-or-stdin>
```

These checks are safe for fresh checkouts because they do not contact Telegram, do not invoke a real non-stub provider task, do not deploy services, and do not execute parsed directive actions. `brainctl run --once --fake-text ...` additionally proves the foreground supervisor and command-intercept path without live entrypoints. `provider smoke codex --transport stub` proves the provider turn contract end-to-end without a real Codex task. `operations plan/validate` prove deployment/update/rollback seams are renderable without mutation. `automation monitor` and `automation run/due --dispatch` can use fake static dispatch plus file spool/locks without installing host schedulers/watchers. `web validate` proves generated-page packages before publish. `validate live --run-safe` runs only config, secret-metadata, runtime-smoke, provider-stub, and no-network entrypoint checks unless explicit live flags are supplied.

Restart tests should not expect exact turn replay. Validate provider-native resume handles where an adapter supports them, and otherwise validate graceful degradation of active jobs/runtime state.

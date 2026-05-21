# brainctl

`brainctl` is the future operator CLI for Brain. In this initial runtime foundation it is intentionally a validation-first skeleton: it prepares private workspace directories and checks config/assistant-pack hygiene, but it does not start a live runtime, contact Telegram, deploy services, or write secrets.

## Commands

```bash
pnpm run brainctl -- setup --workspace personal --path ~/.brain/workspaces/personal
pnpm run brainctl -- doctor --config examples/config/runtime.yaml --pack assistant-packs/core
pnpm run brainctl -- config validate examples/config/runtime.yaml
pnpm run brainctl -- secrets check --config examples/config/runtime.yaml
pnpm run brainctl -- pack validate assistant-packs/core
```

## Safety model

- `setup` creates only private directory scaffolding (`config/`, `secrets/`, `logs/`, `artifacts/`, `state/`, `backups/`, `tmp/`).
- `config validate` enforces the initial single-primary entrypoint policy and secret-free prompt context.
- `secrets check` reports only metadata such as env/file ref presence, mode, and byte size; values are redacted.
- `pack validate` checks assistant-pack manifests, skill frontmatter, and portable public-safety hygiene.
- `doctor` combines the checks above with toolchain and private-boundary placeholder checks.

The CLI is the place future setup, health, runtime, migration, and publisher commands should attach instead of making entrypoint or provider packages own operator workflows.

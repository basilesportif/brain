# Migration skeleton

See `plans/2026-05-21-brain-monorepo-consolidation.md` for the living consolidation plan.

This file will become the stable migration index once phases are locked.


## Current Telegram behavior

The first runtime port should model today's Telegram behavior as a `single-primary` workspace:

- Add one Telegram entrypoint, for example `telegram-main`, as `primaryEntrypointId`.
- Put all active adapters in `enabledEntrypoints`; initially only `telegram-main` should have `enabled: true`.
- Preserve Telegram chat, thread, file, webhook/polling, allowlist, and API details inside `entrypoints/telegram` or its secret/config reference.
- Convert Telegram updates into generic Brain inbound events and convert Brain outbound actions back to Telegram sends, edits, uploads, status updates, and failure notices.
- Route outbound actions to the originating Telegram entrypoint by default.
- Do not enable a second active web/iOS entrypoint during migration; require a later `multi-explicit` config mode with validation and tests.

See `docs/runtime-configuration.md` for the draft config examples and validation rules.

## Short-term workspace state parity

Brain now provides native TypeScript `packages/assistant-logic` JSON workspace
modules and CLI commands for personal state. The authoritative
state files are `data/todos.json`, `data/projects.json`, `data/crm.json`,
`data/reminders.json`, plus `private/documents/metadata.jsonl` for file-save
metadata and `instructions/**`/`tasks/**`/selected repo-registry state for
overlays and automation metadata.

Use `brainctl workspace scaffold/status/run`; it invokes native
assistant-logic CLI commands with `ASSISTANT_WORKSPACE=<workspace>` and private
document roots set. Do not migrate existing markdown notes; `projects/`,
`notes/`, and `documents/metadata/` are resource folders only in this phase.

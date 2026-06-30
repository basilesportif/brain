# Migration skeleton

Status: historical/lab migration notes. The current implementation direction is
Brain as control plane for the separate `codex-chat` servant runtime,
`assistant-agent-logic` repo, and `assistant-agent-data` workspace. Do not use
the parity notes below to justify vendoring or merging servant-stack repos into
Brain.

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

## Assistant-agent-logic migration parity

This section is retained only as historical/lab parity context. It is not the
production architecture and must not be used to justify deploying Brain as the
assistant runtime or treating Brain's copies as canonical. The production
assistant stack uses the live `assistant-agent-logic` checkout resolved from the
repo registry, and Brain deployment/update flows must fetch/update that checkout
and record the resolved SHA.

Legacy lab commands in `packages/assistant-logic` can still exercise JSON-store
compatibility and no-network smoke tests. The larger executable integrations
under `packages/assistant-logic/scripts/**` are compatibility snapshots only;
production domain logic belongs in the separate `assistant-agent-logic` repo and
private `assistant-agent-data` workspace.

Legacy lab wrapper environment:

```bash
ASSISTANT_WORKSPACE=<workspace>
ASSISTANT_PRIVATE_DIR=<workspace>/private
BRAIN_PRIVATE_DIR=<workspace>/private
```

Native state files include `data/todos.json`, `data/projects.json`, `data/crm.json`, `data/reminders.json`, and `private/documents/metadata.jsonl`. The scaffold also creates empty/private-state placeholders for betting, email/calendar/message reminder state, finance sources, and ProtonMail drafts.

Legacy lab code/templates exist in the Brain monorepo for Composio/Gmail/Calendar, ProtonMail Bridge, finance/Mercury/Plaid, WHOOP, Telegram user-client messaging, betting, dictionary, transcription, and loop utilities. Personal data is supplied privately by copying/filling the scaffolded examples in the workspace (`.env.example`, `composio.yaml.example`, `messaging.yaml.example`, `telegram.yaml.example`, `protonmail.yaml.example`) into real private files such as `.env`, `composio.yaml`, `messaging.yaml`, and `protonmail.yaml`. Do not commit those filled files. Do not deploy these snapshots instead of the live `assistant-agent-logic` repo.

Use:

```bash
pnpm run brainctl workspace scaffold --path ~/.brain/workspace
pnpm run brainctl workspace commands --path ~/.brain/workspace
pnpm run brainctl workspace run --path ~/.brain/workspace gmail-recent.js -- --limit 10
pnpm run brainctl workspace run --path ~/.brain/workspace calendar-events.js -- --days 7
pnpm run brainctl workspace run --path ~/.brain/workspace telegram-unread.js
pnpm run brainctl workspace run --path ~/.brain/workspace whoop-profile.js
```

See `docs/assistant-logic-integration-audit.md` for the historical integrated/status table and the remaining lab validation that needs Tim's private credentials/accounts.

# Assistant-agent-logic integration audit

Source audited: `/home/tim/pkg/tim/assistant-agent-logic` at `60089113e49501fd6f8e11c4e81039d1ced3f4b0`.

## Native Brain parity implemented

These assistant-agent-logic areas are now native TypeScript in `packages/assistant-logic/src` and are invoked by `brainctl workspace run` through compiled `dist/cli/*.js` entrypoints:

- Todos: `todo-add.js`, `todo-list.js`, `todo-delete.js`; state `data/todos.json`.
- Projects: add/list/view/update/note/resource/task/delete; state `data/projects.json`.
- CRM: people, businesses, correspondence, follow-ups, pipeline/stale/missing-fields/delete; state `data/crm.json`.
- Reminders: add/list/update/delete/check; state `data/reminders.json`.
- File-save: save/list document metadata and private copies; state `private/documents/metadata.jsonl` and `private/documents/files/**`.
- Workspace helpers: `ASSISTANT_WORKSPACE` path resolution, legacy root-state conflict detection, and instruction/task/repo-registry overlay scaffolding.

The old copied CommonJS `packages/assistant-logic/scripts/**` wrappers were removed.

## Resources vendored for feature parity/reference

The Brain package includes assistant-agent-logic skill/prompt/workspace resources so private workspaces can carry the same overlay layer:

- All upstream `config/skills/*.md` and `config/prompts/*.md` resources, with Brain-specific notes retained for core JSON store skills.
- Upstream `config/workspace-template/**` for migration/reference.
- Repo-registry skill resources, including `assets/controller-runtime` TypeScript source files and installer script (the installer builds its own dist in the private workspace).

## Optional live integrations not ported as scripts

The following upstream integrations remain intentionally out of native Brain scope for this pass because they require external credentials, live network APIs, browser or OAuth flows, or product decisions beyond core workspace parity. Their docs/templates are vendored where useful, but their CommonJS scripts were not copied into Brain:

- Telegram user-client/MTProto history and unread-message scripts. Brain has a native Telegram bot entrypoint for runtime traffic instead.
- Gmail, ProtonMail, generic email, Google Calendar, and Composio live data scripts. Brain currently provides metadata-only Composio setup/status checks and runtime configuration seams, not live mailbox/calendar actions.
- Finance/Mercury/Plaid and Whoop live API scripts.
- Betting scripts and store. The preference prompt/skill docs are vendored; native betting state is not part of core Brain workspace parity.
- Dictionary deployment script. Dictionary project resources can still be modeled through native projects, but deployment to a transcription prompt file is not a core runtime feature.
- One-off utility scripts such as voice transcription and migration helpers that are either superseded by Brain runtime modules or depend on live service credentials.

If any of these become required Brain product surfaces later, they should be reimplemented as native TypeScript packages with metadata-only setup/status checks and tests before adding live execution paths.

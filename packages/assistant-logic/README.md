# @brain/assistant-logic

This package vendors the assistant-agent-logic JSON workspace implementation directly into the Brain monorepo.

Imported source: `/home/tim/pkg/tim/assistant-agent-logic` at commit `60089113e49501fd6f8e11c4e81039d1ced3f4b0`.

Included in this pass:

- JSON-backed scripts and stores for todos, projects, CRM, reminders, and file-save.
- Workspace path helpers needed by those stores.
- Markdown skill/prompt resources used as the base layer for workspace overlays.
- Focused upstream tests for workspace path resolution, legacy-state detection, and file-save behavior.

Not included yet:

- Optional live integrations (Telegram user client, email, calendar, finance, Whoop, Composio, dictionary deployment).
- A native TypeScript port of the copied CommonJS stores.

`brainctl workspace ...` resolves this package inside the current Brain checkout and must not require a sibling `assistant-agent-logic` checkout.

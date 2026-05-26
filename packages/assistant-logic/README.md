# @brain/assistant-logic

This package is the native Brain home for the assistant-agent-logic workspace parity layer.

Imported source baseline: `/home/tim/pkg/tim/assistant-agent-logic` at commit `60089113e49501fd6f8e11c4e81039d1ced3f4b0`.

Included:

- Native TypeScript modules in `src/lib/` for the JSON-backed stores used by todos, projects, CRM, reminders, and file-save.
- Native TypeScript CLI entrypoints in `src/cli/`, compiled to `dist/cli/*.js`, preserving assistant-agent-logic JSON stdout/stderr behavior and ID/schema formats.
- Workspace path helpers, legacy root-state conflict checks, and private file-save git-safety checks.
- Markdown skill/prompt resources and workspace-template overlays from assistant-agent-logic, plus the repo-registry controller runtime assets.
- Tests for workspace resolution, legacy-state migration errors, file-save behavior, and CLI JSON compatibility fixtures.

`brainctl workspace ...` resolves this package inside the current Brain checkout and does not require a sibling `assistant-agent-logic` checkout. The deprecated `--assistant-repo` option is accepted only as a no-op compatibility shim.

Optional network/live integrations from assistant-agent-logic are audited in `../../docs/assistant-logic-integration-audit.md`. Brain vendors their docs/templates where useful, but does not copy their CommonJS live scripts unless a native Brain runtime surface exists.

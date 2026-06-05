# @brain/assistant-logic

This package is the native Brain home for the assistant-agent-logic workspace parity layer.

Imported source baseline: `/home/tim/pkg/tim/assistant-agent-logic`, refreshed by the 2026-06-05 parity/concurrency pass.

Included:

- Native TypeScript modules in `src/lib/` for the JSON-backed stores used by todos, projects, CRM, reminders, conference lists/favorites, and file-save.
- Native TypeScript CLI entrypoints in `src/cli/`, compiled to `dist/cli/*.js`, preserving assistant-agent-logic JSON stdout/stderr behavior and ID/schema formats.
- Workspace path helpers, legacy root-state conflict checks, JSON-store advisory locks/transactions with unique temp files, and private file-save git-safety checks.
- Markdown skill/prompt resources and workspace-template overlays from assistant-agent-logic, plus the repo-registry controller runtime assets.
- Vendored assistant-agent-logic CommonJS/MJS/shell scripts under `scripts/**` for live integrations that are not yet native TypeScript: Composio/Gmail/Calendar, ProtonMail Bridge, finance/Mercury/Plaid, WHOOP, Telegram MTProto user-client messaging, betting, dictionary, transcription, dispatch, and loop utilities.
- Tests for workspace resolution, legacy-state migration errors, file-save behavior, CLI JSON compatibility fixtures, and Brain wrapper discovery/execution of vendored commands.

`brainctl workspace ...` resolves this package inside the current Brain checkout and does not require a sibling `assistant-agent-logic` checkout. The deprecated `--assistant-repo` option is accepted only as a no-op compatibility shim. Core commands run from compiled `dist/cli/*.js`; live integrations run from in-repo `scripts/*` with `ASSISTANT_WORKSPACE`, `ASSISTANT_PRIVATE_DIR`, and `BRAIN_PRIVATE_DIR` set.

Personal data and credentials stay in the private Brain workspace. See `../../docs/assistant-logic-integration-audit.md` for the integrated/status table and live validation checklist.

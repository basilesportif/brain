# @brain/assistant-logic

Legacy/lab compatibility package only. Brain's production role is the
deployment/control plane for the real `codex-chat` runtime and the separate
`assistant-agent-logic` repository; this package is not canonical assistant
domain logic and must not be deployed in place of that live checkout.

Imported source baseline: `/home/tim/pkg/tim/assistant-agent-logic` at commit `04570bed4e9abe1d9829a48dde6adbe4d2e11a0b`.

Included for lab parity/no-network compatibility:

- Native TypeScript modules in `src/lib/` for the JSON-backed stores used by todos, projects, CRM, reminders, and file-save.
- Native TypeScript CLI entrypoints in `src/cli/`, compiled to `dist/cli/*.js`, preserving assistant-agent-logic JSON stdout/stderr behavior and ID/schema formats.
- Workspace path helpers, legacy root-state conflict checks, and private file-save git-safety checks.
- Markdown skill/prompt resources and workspace-template overlays from assistant-agent-logic, plus the repo-registry controller runtime assets.
- Snapshot assistant-agent-logic CommonJS/MJS/shell scripts under `scripts/**`
  for legacy/lab compatibility with Composio/Gmail/Calendar, ProtonMail Bridge,
  finance/Mercury/Plaid, WHOOP, Telegram MTProto user-client messaging, betting,
  dictionary, transcription, dispatch, and loop utilities.
- Tests for workspace resolution, legacy-state migration errors, file-save behavior, CLI JSON compatibility fixtures, and Brain wrapper discovery/execution of vendored commands.

`brainctl workspace ...` resolves this package inside the current Brain checkout
only for compatibility commands and tests. Production deployment must resolve,
fetch/update, verify, and record the SHA of the sibling/remote
`assistant-agent-logic` checkout from repo-registry metadata. The deprecated
`--assistant-repo` option is accepted only as a no-op compatibility shim for
legacy lab commands. Core commands run from compiled `dist/cli/*.js`;
compatibility scripts run from in-repo `scripts/*` with `ASSISTANT_WORKSPACE`,
`ASSISTANT_PRIVATE_DIR`, and `BRAIN_PRIVATE_DIR` set.

Personal data and credentials stay in the private Brain workspace. See `../../docs/assistant-logic-integration-audit.md` for the integrated/status table and live validation checklist.

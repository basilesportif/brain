# Assistant-agent-logic integration audit

Status: historical/lab parity audit. Brain's current production architecture is
control-plane first: resolve and manage the separate `assistant-agent-logic`
repository and `assistant-agent-data` workspace through repo-registry metadata.
The in-repo paths below are compatibility/lab surfaces, not a directive to
vendor or merge source for servant runtime deployment.

Source audited: `/home/tim/pkg/tim/assistant-agent-logic` at `60089113e49501fd6f8e11c4e81039d1ced3f4b0`.

Goal: Tim can move the codex-chat/assistant-agent-logic setup to Brain without functionality loss while keeping personal data, credentials, OAuth/session tokens, account ids, and live API results in the private workspace only.

## Integration status

| Assistant-agent-logic area | Brain status | Brain location | Private data / setup required |
| --- | --- | --- | --- |
| Todos | Native TypeScript | `packages/assistant-logic/src/lib/todo-store.ts`, `src/cli/todo-*.ts`; run with `brainctl workspace run todo-*.js` | `data/todos.json` in private workspace |
| Projects | Native TypeScript | `packages/assistant-logic/src/lib/project-store.ts`, `src/cli/project-*.ts` | `data/projects.json` plus optional private resource folders |
| CRM | Native TypeScript | `packages/assistant-logic/src/lib/crm-store.ts`, `src/cli/crm-*.ts` | `data/crm.json` |
| Reminders | Native TypeScript | `packages/assistant-logic/src/lib/reminder-store.ts`, `src/cli/reminder-*.ts` | `data/reminders.json` |
| File-save | Native TypeScript | `packages/assistant-logic/src/lib/file-save-store.ts`, `src/cli/file-*.ts` | `private/documents/metadata.jsonl` and private document bytes |
| Betting | Legacy/lab compatibility snapshot | `packages/assistant-logic/scripts/bet-*.js`; run with `brainctl workspace run bet-*.js` only for lab parity | `data/bets.json`; bet entries are private workspace data |
| Google Calendar and invite allowlist | Legacy/lab executable snapshot | `scripts/calendar-*.js`, `scripts/update-calendar-event.js`, `scripts/flag-event.js`, `scripts/fix-football-events.js` | `COMPOSIO_API_KEY` in workspace `.env`; connected account ids/calendars in private `composio.yaml`; state in `data/calendar-allowlist.json`, `seen-invites.json`, `declined-invites-log.json`, `flagged-events.json` |
| Gmail / generic actionable email | Legacy/lab executable snapshot | `scripts/gmail-*.js`, `email-actionable.js`, `urgent-email.js`, `dismiss-email.js` | `COMPOSIO_API_KEY` and Gmail connected account ids in private workspace; email state in `data/seen-emails.json`, `dismissed-emails.json`, `urgent-emails.json` |
| Composio connection management | Legacy/lab executable snapshot plus native metadata status | `scripts/composio-connect.js`; `brainctl composio setup/status` for no-secret checks | `COMPOSIO_API_KEY`, connected account ids, and optional account labels supplied privately |
| ProtonMail Bridge | Legacy/lab executable snapshot | `scripts/protonmail-*.js`, `scripts/lib/protonmail-*.js`; template `config/workspace-template/protonmail.yaml` | ProtonMail Bridge Docker/container login remains interactive; Bridge password goes only in private `.env`; metadata in private `protonmail.yaml`; drafts/audit in private `data/` |
| Finance / Plaid / Mercury | Legacy/lab executable snapshot | `scripts/finance-*.js`, `scripts/mercury-*.js`, `scripts/plaid-link.js`, finance/Mercury libs | Tokens in private `.env`; source metadata in `data/finance-sources.json`; live bank data is private output/state |
| WHOOP | Legacy/lab executable snapshot | `scripts/whoop-*.js`, `scripts/lib/whoop-*.js`; template `.env.example` includes OAuth refs | WHOOP OAuth client secret and token record stay private (`.env`, `data/whoop-auth.json`) |
| Telegram user-client / MTProto messaging | Legacy/lab executable snapshot | `scripts/telegram-login.js`, `telegram-history.js`, `telegram-unread.js`, `messages-unread.js`, `urgent-message.js`, `dismiss-message.js`, Telegram libs | Telegram API id/hash/session stay in private `messaging.yaml`; message reminder state in private `data/` |
| Telegram bot runtime | Lab-only Brain entrypoint; production uses `codex-chat.service` | `entrypoints/telegram`, `brainctl run/start/entrypoint check` for tests only | Bot token supplied through env/file refs; pairing/polling/download state private |
| Dictionary deployment | Legacy/lab utility snapshot | `scripts/dictionary-deploy.js`; skill resource in `config/skills/dictionary.md` | Target prompt/config path is operator/private environment specific |
| Voice transcription / Claude SDK dispatch / loops | Legacy/lab utility snapshot | `scripts/transcribe-voice.js`, `dispatch-claude-sdk.mjs`, `register-loops.sh`, `scripts/tasks/**` | Provider keys and scheduled-task installs are private/operator actions |
| Skills, prompts, reference docs, workspace templates | Legacy/lab resource snapshots | `packages/assistant-logic/config/skills/**`, `config/prompts/**`, `config/SEARCH.md`, `config/TELEGRAM.md`, `config/workspace-template/**` | Workspace overlays and filled config files are private; production uses the external `assistant-agent-logic` checkout |
| Repo-registry resources | Legacy/lab resource snapshots plus Brain setup guidance | `config/skills/repo-registry/**` and workspace scaffold `.claude/repo-registry/**` | Real host/path registry entries stay private |

## What changed from the previous audit

The former "optional live integrations not ported as scripts" section is now
historical. Those snapshots remain only for lab compatibility and no-network
parity tests. They are not canonical source and must not be deployed in place of
the external `assistant-agent-logic` checkout resolved by Brain's control-plane
stack commands.

## Security boundary

Included in Brain for legacy/lab compatibility only:

- snapshot source code under `packages/assistant-logic/scripts/**`;
- shared skills/prompts/reference docs/templates under `packages/assistant-logic/config/**`;
- dependency declarations needed to execute the vendored scripts; and
- `brainctl` wrappers that pass only workspace path environment metadata and do not print secret values.

Production deployment instead updates and uses the separate
`assistant-agent-logic` checkout. Brain deployment metadata records the requested
ref and resolved SHA for that checkout.

Excluded from Brain:

- `/home/tim/pkg/tim/assistant-agent-logic/workspace/**` and any filled workspace files;
- `.env`, OAuth/token/session files, Telegram MTProto sessions, ProtonMail Bridge passwords, API keys, account ids that Tim considers private, and live API outputs;
- private logs/caches/document bytes.

`brainctl workspace scaffold` writes only empty JSON stores and example templates such as `.env.example`, `composio.yaml.example`, `messaging.yaml.example`, `telegram.yaml.example`, and `protonmail.yaml.example`. Operators copy/rename/fill those files inside the private workspace.

## Verification coverage

Automated Brain checks cover:

- TypeScript build of the native packages and `brainctl` wrapper;
- no-network native CLI compatibility tests;
- `brainctl workspace scaffold/status/commands` discovery of native and vendored commands;
- no-secret vendored betting script execution through `brainctl workspace run` using a temporary private workspace.

Live API behavior still requires Tim's private credentials/accounts and should be validated after migration with private workspace files in place:

- Composio account listing/link checks;
- Gmail/Calendar read/write smoke checks;
- ProtonMail Bridge IMAP/SMTP checks;
- Finance/Mercury/Plaid account/transaction reads;
- WHOOP OAuth connect and read endpoints;
- Telegram user-client login/history/unread checks.

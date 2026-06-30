# Brain parity matrix against assistant-agent-logic, codex-chat, and codex-chat-web

Status: historical/lab parity audit. The current architecture is control-plane
first: Brain manages the separate `codex-chat` servant runtime,
`assistant-agent-logic` repo, and `assistant-agent-data` workspace through
repo-registry metadata. Entries below describe compatibility work and must not
be read as a production directive to vendor or merge those repos into Brain, or
to run Brain Telegram polling instead of `codex-chat.service`.

Audit date: 2026-05-26.

Sources checked:

- `assistant-agent-logic` authoritative local checkout: `/home/tim/pkg/tim/assistant-agent-logic`.
- `brain` authoritative local checkout: `/home/tim/pkg/tim/brain`.
- `codex-chat` authoritative remote checkout from repo-registry: `tim@89.167.72.52:/home/tim/pkg/tim/codex-chat`; inspected with `git archive` over SSH.
- `codex-chat-web` authoritative remote checkout from repo-registry: `tim@89.167.72.52:~/pkg/tim/codex-chat-web`; inspected with `git archive` over SSH.

Private data/secrets were not read. Credential-dependent parity means the code path, template, prompt guidance, metadata-only checks, and validation command exist; live account values remain private workspace inputs.

| Assistant feature | Brain support status | Implementation path | Test/validation | Live credential requirement |
| --- | --- | --- | --- | --- |
| Skills and behavior-pack rules | Historical/lab only | Runtime prompt builder in `packages/runtime-core/src/runtime.ts`; portable pack in `assistant-packs/core`; assistant-agent skill resource snapshots in `packages/assistant-logic/config/skills` | `packages/runtime-core/src/runtime.test.ts`; `brainctl pack validate` | None for static validation; production domain prompts/skills come from `assistant-agent-logic` |
| Assistant-agent-logic scripts/resources | Historical/lab snapshots only | Compatibility scripts in `packages/assistant-logic/scripts`; resources/templates in `packages/assistant-logic/config` | `brainctl workspace commands/status/run` for lab parity | Production deploys the live `assistant-agent-logic` checkout and records requested ref + resolved SHA |
| Workspace JSON stores: todos, projects, CRM, reminders | Historical/lab compatibility only | `packages/assistant-logic/src/lib/*-store.ts`; CLI wrappers; workspace scaffold in `src/brainctl.ts` | `pnpm run check`; `brainctl workspace scaffold/status/run` | Private workspace JSON data only |
| File-save / PDF attach | Historical/lab compatibility only | `packages/assistant-logic/src/lib/file-save-store.ts`; `file-save.js`; prompt and skill guidance | CLI compatibility tests; git-ignore destination guard | Source attachments and private saved bytes stay outside repo |
| Telegram bot ingress/egress | Lab adapter tests only; production uses codex-chat.service | `entrypoints/telegram/src/index.ts`; disabled `brainctl run --telegram-polling` guard | Telegram adapter tests; `brainctl entrypoint check`; `brainctl validate live --run-safe` metadata only | Bot token, paired users/chats, download/transcription files are private |
| Telegram send-path allowlist | Lab adapter tests only | `TelegramEntrypointAdapterOptions.allowedSendRoots`; production send paths live in codex-chat | `entrypoints/telegram/src/index.test.ts` refuses sends outside configured roots | No; configured roots are metadata paths |
| Telegram voice/audio/video transcription | Lab adapter seam only | `entrypoints/telegram/src/transcription.ts`; OpenAI command/API seam in `src/brainctl.ts` | Entry-point transcription tests; metadata-only secret checks | OpenAI API key and private audio files |
| Runtime directives / legacy codex-chat fences | Lab compatibility only | `packages/runtime-core/src/directives.ts`; legacy `send_image`, `send_document`, `cancel_job`, targets normalized | Directive tests; `brainctl directives check` | None |
| Subagents lifecycle/results/steering | Lab compatibility seam only | `packages/runtime-core/src/subagents.ts`, `supervisor.ts`, `command-intercepts.ts`; provider-backed executor | Runtime/subagent/supervisor/command tests | Live provider auth for Codex/Claude execution |
| Subagent stress/fan-out behavior | Historical/lab prompt experiment only | Deprecated prompt guidance; production policy lives in assistant-agent-logic/codex-chat | `packages/runtime-core/src/runtime.test.ts` | None |
| Employee/durable agents | Lab provider seam only | `packages/runtime-core/src/employees.ts`; `ProviderEmployeeRuntime`; service commands | Employee and command-intercept tests; `brainctl run --employee-runtime` | Live provider auth for real sessions |
| Service commands: help, logs, health, agents, employees, deploy/update seam | Lab command-intercept seam only; production commands live in codex-chat | `packages/runtime-core/src/command-intercepts.ts`; `src/brainctl.ts` supervisor wiring | Command-intercept and supervisor tests | Live logs/state only in private workspace |
| Service command log redaction | Lab compatibility coverage | `formatLogEntry` redacts message text and raw payloads | `packages/runtime-core/src/command-intercepts.test.ts` covers raw and message secrets | None |
| Loops/monitors CLI and fake execution | Supported | `packages/runtime-core/src/automation.ts`; `brainctl automation validate/run/due/monitor` | Automation tests and CLI tests | Live host scheduler/watcher setup remains operator-specific |
| Loops status chat command | Historical/lab experiment only | `RuntimeCommandInterceptor` accepts optional automation inspection port for lab smoke | Command-intercept test | Private loop prompts/config may live outside repo |
| Codex provider exec/app-server | Lab provider seam only | `packages/providers/codex/src`; `brainctl provider check/smoke` | Provider tests; live smoke guarded by `--allow-live` | Codex auth/session and app-server endpoint if used |
| Generated images | Historical/lab prompt experiment only | Production image workflow lives in codex-chat/assistant-agent-logic | Prompt tests; Telegram artifact dispatch tests | Image generation provider output/private artifacts |
| Scratch pages / web publishing | Control-plane web publisher support only | `apps/web/src/generated-pages.ts`; `brainctl web validate/publish/prune/manifest`; generated-web-page skill | Web publisher tests; `brainctl web *` | Public domain/runtime root/Google Maps browser key when needed |
| codex-chat-web runtime-host compatibility | Supported after this audit | `runtimeHost` option and `CODEX_CHAT_WEB_*` env aliases in `@brain/web`; CLI `--runtime-host` | Web tests cover env aliases; remote path code mirrors codex-chat-web | SSH access to runtime host for remote publish/prune |
| Setup / migration | Supported | `AGENTS.md`, `CLAUDE.md`, `docs/setup-plan.md`, `src/brainctl.ts setup*`, setup skill | `brainctl setup defaults/inspect/status`; CLI tests | Private remote host/service user/token details |
| Backup/restore planning | Supported for safe metadata and init | `brainctl backup plan/init/check/status`; workspace schema backup config | CLI tests; metadata-only checks | Private backup remote/repo path and private data |
| Calendar/Gmail/Composio | Historical/lab snapshots only | `packages/assistant-logic/scripts/calendar-*`, `gmail-*`, `composio-connect.js`; `composio.yaml` template | Command catalog; metadata-only `brainctl composio status`; optional lab execution through `workspace run` | Production account logic comes from the live `assistant-agent-logic` checkout; Composio API key and connected account ids stay private |
| ProtonMail | Historical/lab snapshot only | `protonmail-*.js`, ProtonMail libs, `protonmail.yaml` template | Command catalog and script import/build coverage | Production account logic comes from the live `assistant-agent-logic` checkout; Bridge login/password/account state stays private |
| Messaging / Telegram user client | Historical/lab snapshot only | `telegram-login/history/unread`, `messages-unread`, urgent/dismiss scripts and `messaging.yaml` | Command catalog | Production account logic comes from the live `assistant-agent-logic` checkout; MTProto api id/hash/session and message state stay private |
| Finance / Mercury / Plaid | Historical/lab snapshots only | `finance-*`, `mercury-*`, `plaid-link.js`, finance provider libs | Command catalog; workspace scaffold | Production account logic comes from the live `assistant-agent-logic` checkout; bank/OAuth/API tokens and private financial outputs stay private |
| Health / WHOOP | Historical/lab snapshot only | `whoop-*` scripts/libs and `.env.example` refs | Command catalog; workspace scaffold | Production account logic comes from the live `assistant-agent-logic` checkout; WHOOP OAuth client secret/token data stays private |
| Betting | Historical/lab vendored no-network workflow only | `bet-*.js`, skill/prompt resources | `brainctl workspace run bet-*.js` no-secret test coverage | Private bets data only |
| Web page design guidance | Historical/lab resource snapshot only | `packages/assistant-logic/config/skills/web-page-design.md`; generated-page skill split | Skill file presence and prompt routing | Private project notes optional |
| Repo-registry authority | Control-plane support | `packages/assistant-logic/config/skills/repo-registry`; `assistant-packs/core/skills/repo-registry`; setup scaffolds registry paths | Skill/resource file diff; workspace scaffold | Real repo registry entries may be private |

## Gaps fixed in this audit

1. Reclassified Telegram adapter, runtime prompt, subagent, and command-intercept work as lab compatibility only.
2. Removed production setup authority from Brain prompt/assistant-domain snapshots; production uses `codex-chat.service` plus `assistant-agent-logic`.
3. Kept metadata-safe validation, web publisher, and repo-registry seams as control-plane support only.
4. Deployment/update must refresh configured servant repos, verify resolved SHAs, and record deployment metadata.

## Areas intentionally credential-dependent

Live Telegram traffic, Codex sessions, Composio/Gmail/Calendar, ProtonMail Bridge, Telegram user-client messaging, Mercury/Plaid, WHOOP, hosted scratch-page URL smoke tests, Google Maps page keys, and private backup remotes require Tim's private credentials or data. Brain keeps only metadata refs/checks and must not use those lab paths as production assistant behavior.

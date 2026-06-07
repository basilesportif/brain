# Brain parity matrix against assistant-agent-logic, codex-chat, and codex-chat-web

Status: historical/lab parity audit. The current architecture is control-plane
first: Brain manages the separate `codex-chat` servant runtime,
`assistant-agent-logic` repo, and `assistant-agent-data` workspace through
repo-registry metadata. Entries below describe compatibility work and must not
be read as a production directive to vendor or merge those repos into Brain.

Audit date: 2026-05-26.

Sources checked:

- `assistant-agent-logic` authoritative local checkout: `/home/tim/pkg/tim/assistant-agent-logic`.
- `brain` authoritative local checkout: `/home/tim/pkg/tim/brain`.
- `codex-chat` authoritative remote checkout from repo-registry: `tim@89.167.72.52:/home/tim/pkg/tim/codex-chat`; inspected with `git archive` over SSH.
- `codex-chat-web` authoritative remote checkout from repo-registry: `tim@89.167.72.52:~/pkg/tim/codex-chat-web`; inspected with `git archive` over SSH.

Private data/secrets were not read. Credential-dependent parity means the code path, template, prompt guidance, metadata-only checks, and validation command exist; live account values remain private workspace inputs.

| Assistant feature | Brain support status | Implementation path | Test/validation | Live credential requirement |
| --- | --- | --- | --- | --- |
| Skills and behavior-pack rules | Supported | Runtime prompt builder in `packages/runtime-core/src/runtime.ts`; portable pack in `assistant-packs/core`; assistant-agent skill resources in `packages/assistant-logic/config/skills` | `packages/runtime-core/src/runtime.test.ts`; `brainctl pack validate` | None for static validation; workspace overlays private |
| Assistant-agent-logic scripts/resources | Supported | Vendored scripts in `packages/assistant-logic/scripts`; resources/templates in `packages/assistant-logic/config` | `diff -qr` against source shows only Brain path/safety adaptations plus generated CommonJS package marker; `brainctl workspace commands/status/run` | Live integrations need private `.env`, account ids, sessions, OAuth tokens |
| Workspace JSON stores: todos, projects, CRM, reminders | Supported natively | `packages/assistant-logic/src/lib/*-store.ts`; CLI wrappers; workspace scaffold in `src/brainctl.ts` | `pnpm run check`; `brainctl workspace scaffold/status/run` | Private workspace JSON data only |
| File-save / PDF attach | Supported natively | `packages/assistant-logic/src/lib/file-save-store.ts`; `file-save.js`; prompt and skill guidance | CLI compatibility tests; git-ignore destination guard | Source attachments and private saved bytes stay outside repo |
| Telegram bot ingress/egress | Supported with guarded live mode | `entrypoints/telegram/src/index.ts`; `brainctl run/start --entrypoint telegram` | Telegram adapter tests; `brainctl entrypoint check`; `brainctl validate live --run-safe` | Bot token, paired users/chats, download/transcription files are private |
| Telegram send-path allowlist | Supported after this audit | `TelegramEntrypointAdapterOptions.allowedSendRoots`; `brainctl run/start` wires artifact/download/private-document roots | `entrypoints/telegram/src/index.test.ts` refuses sends outside configured roots | No; configured roots are metadata paths |
| Telegram voice/audio/video transcription | Supported as injectable seam | `entrypoints/telegram/src/transcription.ts`; OpenAI command/API seam in `src/brainctl.ts` | Entry-point transcription tests; metadata-only secret checks | OpenAI API key and private audio files |
| Runtime directives / legacy codex-chat fences | Supported | `packages/runtime-core/src/directives.ts`; legacy `send_image`, `send_document`, `cancel_job`, targets normalized | Directive tests; `brainctl directives check` | None |
| Subagents lifecycle/results/steering | Supported | `packages/runtime-core/src/subagents.ts`, `supervisor.ts`, `command-intercepts.ts`; provider-backed executor | Runtime/subagent/supervisor/command tests | Live provider auth for Codex/Claude execution |
| Subagent stress/fan-out behavior | Supported after this audit | Added explicit runtime/pack prompt guidance for stress/fan-out requests | `packages/runtime-core/src/runtime.test.ts` | None |
| Employee/durable agents | Supported as provider-backed seam | `packages/runtime-core/src/employees.ts`; `ProviderEmployeeRuntime`; service commands | Employee and command-intercept tests; `brainctl run --employee-runtime` | Live provider auth for real sessions |
| Service commands: help, logs, health, agents, employees, deploy/update seam | Supported | `packages/runtime-core/src/command-intercepts.ts`; `src/brainctl.ts` supervisor wiring | Command-intercept and supervisor tests | Live logs/state only in private workspace |
| Service command log redaction | Supported after this audit | `formatLogEntry` redacts message text and raw payloads | `packages/runtime-core/src/command-intercepts.test.ts` covers raw and message secrets | None |
| Loops/monitors CLI and fake execution | Supported | `packages/runtime-core/src/automation.ts`; `brainctl automation validate/run/due/monitor` | Automation tests and CLI tests | Live host scheduler/watcher setup remains operator-specific |
| Loops status chat command | Supported after this audit | `RuntimeCommandInterceptor` accepts optional automation inspection port; `brainctl run/start --automation-file` can expose loop/monitor health to `loops` / `loop status` | Command-intercept test | Private loop prompts/config may live outside repo |
| Codex provider exec/app-server | Supported as provider seam | `packages/providers/codex/src`; `brainctl provider check/smoke` | Provider tests; live smoke guarded by `--allow-live` | Codex auth/session and app-server endpoint if used |
| Generated images | Supported by prompt/runtime workflow | Runtime prompt requires implementer subagent, staging under artifacts, `deleteAfterSend` for disposable copies | Prompt tests; Telegram artifact dispatch tests | Image generation provider output/private artifacts |
| Scratch pages / web publishing | Supported | `apps/web/src/generated-pages.ts`; `brainctl web validate/publish/prune/manifest`; generated-web-page skill | Web publisher tests; `brainctl web *` | Public domain/runtime root/Google Maps browser key when needed |
| codex-chat-web runtime-host compatibility | Supported after this audit | `runtimeHost` option and `CODEX_CHAT_WEB_*` env aliases in `@brain/web`; CLI `--runtime-host` | Web tests cover env aliases; remote path code mirrors codex-chat-web | SSH access to runtime host for remote publish/prune |
| Setup / migration | Supported | `AGENTS.md`, `CLAUDE.md`, `docs/setup-plan.md`, `src/brainctl.ts setup*`, setup skill | `brainctl setup defaults/inspect/status`; CLI tests | Private remote host/service user/token details |
| Backup/restore planning | Supported for safe metadata and init | `brainctl backup plan/init/check/status`; workspace schema backup config | CLI tests; metadata-only checks | Private backup remote/repo path and private data |
| Calendar/Gmail/Composio | Supported as vendored live integrations | `packages/assistant-logic/scripts/calendar-*`, `gmail-*`, `composio-connect.js`; `composio.yaml` template | Command catalog; metadata-only `brainctl composio status`; vendored script execution through `workspace run` | Composio API key and connected account ids |
| ProtonMail | Supported as vendored live integration | `protonmail-*.js`, ProtonMail libs, `protonmail.yaml` template | Command catalog and script import/build coverage | Bridge login/password/account state |
| Messaging / Telegram user client | Supported as vendored live integration | `telegram-login/history/unread`, `messages-unread`, urgent/dismiss scripts and `messaging.yaml` | Command catalog | MTProto api id/hash/session and message state |
| Finance / Mercury / Plaid | Supported as vendored live integrations | `finance-*`, `mercury-*`, `plaid-link.js`, finance provider libs | Command catalog; workspace scaffold | Bank/OAuth/API tokens and private financial outputs |
| Health / WHOOP | Supported as vendored live integration | `whoop-*` scripts/libs and `.env.example` refs | Command catalog; workspace scaffold | WHOOP OAuth client secret/token data |
| Betting | Supported as vendored no-network JSON workflow | `bet-*.js`, skill/prompt resources | `brainctl workspace run bet-*.js` no-secret test coverage | Private bets data only |
| Web page design guidance | Supported | `packages/assistant-logic/config/skills/web-page-design.md`; generated-page skill split | Skill file presence and prompt routing | Private project notes optional |
| Repo-registry authority | Supported | `packages/assistant-logic/config/skills/repo-registry`; `assistant-packs/core/skills/repo-registry`; setup scaffolds registry paths | Skill/resource file diff; workspace scaffold | Real repo registry entries may be private |

## Gaps fixed in this audit

1. Added Telegram local artifact send-root validation so live Telegram cannot upload arbitrary provider-emitted filesystem paths.
2. Added loop/monitor status service-command parity (`loops` / `loop status`) via an automation inspection seam and `brainctl run/start --automation-file` wiring.
3. Hardened runtime log redaction so secret-looking text in log messages is redacted, not just structured raw payloads.
4. Added codex-chat-web compatible web-publisher env aliases and remote runtime-host publish/prune support in Brain's web package/CLI.
5. Added explicit stress/fan-out subagent prompt guidance.

## Areas intentionally credential-dependent

Live Telegram sends/polling, Codex app-server turns, Composio/Gmail/Calendar, ProtonMail Bridge, Telegram user-client messaging, Mercury/Plaid, WHOOP, hosted scratch-page URL smoke tests, Google Maps page keys, and private backup remotes require Tim's private credentials or data. Brain now keeps those as private inputs while retaining code paths, templates, prompts, and metadata-safe validation commands.

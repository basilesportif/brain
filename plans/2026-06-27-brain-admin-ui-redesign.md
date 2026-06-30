# Brain admin UI redesign plan

Date: 2026-06-27  
Status: integrated plan updated and implementation completed in this change

## Scope

Redesign the current Brain `/admin` page into a daily-use control-plane dashboard
for the concrete Brain instance while preserving existing server/API safety
boundaries. This plan is intentionally limited to information architecture,
layout, interaction behavior, and rollout criteria. It does not change runtime
code, service commands, env files, secrets, or deployment state.

## Source review

Repository context inspected:

- `/home/tim/.assistant-claude/workspace/.claude/repo-registry/index.yaml` lists
  `brain` as authoritative local at `/home/tim/pkg/tim/brain`, with remote
  `https://github.com/basilesportif/brain` and branch
  `codex/brain-crm-projects-parity`.
- `apps/web/src/admin-page.ts` currently renders the full admin HTML/CSS/JS in
  one template string, with a topbar, account card, status card, and auto-fit
  grid of cards for health, raw settings JSON, Slack settings, Slack manifest,
  generic env writes, and deploy/restart (`apps/web/src/admin-page.ts:56-90`).
- `apps/web/src/admin-service.ts` already exposes the key APIs the redesign
  should organize around: `/me`, `/health`, `/settings`, env read/write, Slack
  settings read/write, Slack manifest render/download, and codex-chat
  operations (`apps/web/src/admin-service.ts:152-187`).
- The service returns presence-only env metadata and redacted config/operation
  data (`apps/web/src/admin-service.ts:190-258`), writes env/Slack settings
  behind approval strings and audit events (`apps/web/src/admin-service.ts:261-299`),
  renders the codex-chat-owned Slack manifest from the checked-out renderer
  (`apps/web/src/admin-service.ts:301-317`), and gates plan/restart/deploy with
  exact approval, self-service refusal, dry-run planning, redacted audit, and
  redacted output (`apps/web/src/admin-service.ts:349-409`).
- `docs/brain-admin-service.md` establishes that this concrete Brain instance
  controls the local codex-chat checkout/service rather than historical remote
  repo-registry targets (`docs/brain-admin-service.md:5-18`), documents routes
  and write-only/presence-only semantics (`docs/brain-admin-service.md:47-66`),
  requires visible account/switch-account UX in all auth states
  (`docs/brain-admin-service.md:68-78`), and documents exact operation approval
  phrases plus the no-self-restart caution (`docs/brain-admin-service.md:80-106`).
- `apps/web/src/admin-page.ts` now also exposes a separate **Capabilities** nav
  item/section as the Phase 5 read-only planning surface, keeping capability
  catalog and grant/audit vocabulary out of Slack setup, Runtime Config, and
  Audit Log until enforcement is explicit and audited.
- `apps/web/src/admin-service.test.ts` covers fail-closed auth, visible account
  controls, concrete-instance settings, write-only env behavior, exact operation
  approval, auditing, manifest rendering, and self-service refusal
  (`apps/web/src/admin-service.test.ts:87-260` and subsequent operation/manifest
  tests). `apps/web/smoke/admin-signin-smoke.mjs` validates the sign-in and
  signed-in account-control flows in Playwright (`apps/web/smoke/admin-signin-smoke.mjs:34-66`).

External design/security guidance consulted:

- NN/g progressive disclosure: show the most important options first and reveal
  specialized/advanced options only on request; label disclosure paths clearly
  and avoid burying frequently used controls.
  <https://www.nngroup.com/articles/progressive-disclosure/>
- MUI/Material app bar guidance: top app bars carry screen identity,
  navigation, and actions; dense desktop toolbars and responsive menu/drawer
  patterns are acceptable.
  <https://mui.com/material-ui/react-app-bar/>
- Microsoft Fluent layout guidance: spacing should create relationships,
  hierarchy, focus, and readable density; excessive density is disorienting.
  <https://fluent2.microsoft.design/layout>
- USWDS alerts, tables, forms, and text inputs: use status/alert regions for
  system and validation feedback, tables for complex comparable metadata,
  explicit labels instead of placeholder-only instructions, helper text and
  inline validation instead of unclear disabled states.
  <https://designsystem.digital.gov/components/alert/>,
  <https://designsystem.digital.gov/components/table/>,
  <https://designsystem.digital.gov/components/text-input/>,
  <https://designsystem.digital.gov/components/form/>
- OWASP secrets management: keep centralized, access-controlled, audited secret
  handling with rotation/lifecycle thinking and least-privilege access; UI must
  not turn secret values into browseable or logged data.
  <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>
- GitHub secret settings UX: secrets live in security/settings areas and require
  privileged access to create; the common pattern is create/list metadata rather
  than disclose stored secret values.
  <https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets>
- Android responsive navigation guidance: keep one navigation model across
  window sizes, adapting list/detail and one-pane/two-pane presentation rather
  than creating separate mobile semantics.
  <https://developer.android.com/develop/ui/views/layout/build-responsive-navigation>

## Current UI problems to solve

1. **Flat card wall.** The current auto-fit grid makes all controls appear equal:
   raw JSON, daily Slack setup, manifest rendering, env writes, and restart are
   visually peers (`apps/web/src/admin-page.ts:65-71`).
2. **Raw JSON dominates.** Health/settings are currently `<pre>` payloads, which
   are useful for debugging but poor as the default status surface.
3. **Account controls are present but oversized.** The Clerk account card meets
   the documented switch-account requirement, but it consumes prime desktop
   space better used for instance health and operational state.
4. **Secrets are safe but not ergonomic.** Write-only Slack/env fields exist, but
   they need grouped labels, presence badges, restart-required feedback, and
   clearer “leave blank to keep existing value” behavior without relying on
   placeholder text alone.
5. **Manifest is always expanded.** A large readonly textarea is shown by
   default even when the operator only needs request URL, render state, copy, or
   download.
6. **Deploy/restart is too compact.** Plan/restart/deploy share one small card;
   the UI should make dry-run planning primary, live actions secondary, and
   approvals harder to mis-enter or run accidentally.
7. **Feedback is fragmented.** Each card has its own `<pre>` result. Operators
   need a unified status/audit strip plus inline feedback near the control that
   produced it.
8. **Mobile behavior is implicit.** The current responsive grid stacks, but it
   does not define mobile navigation, sticky status, action placement, or how to
   keep dangerous controls deliberate on small screens.

## Redesign principles

- **Overview first, raw detail later.** The first screen answers: am I signed in,
  which Brain instance am I controlling, is codex-chat healthy, is Slack ready,
  are required secrets present, and are any restarts/deploys pending?
- **Daily paths beat setup paths.** Frequent health, Slack status, manifest copy,
  and restart-required status stay one click away; generic env/config escape
  hatches and raw JSON sit behind Advanced/Details.
- **Dense but scannable.** Use compact cards, tables, badges, and monospace only
  where paths/keys/commands need it. Do not turn every API response into a raw
  code block.
- **Secrets remain write-only.** Show key name, required/optional role, presence,
  last-write/audit metadata when available, restart requirement, and a write
  control. Never show stored values, never prefill inputs, and clear fields after
  success.
- **Dangerous actions require staging.** Make `plan codex-chat.service` the
  default path. Restart/deploy require an explicit selected operation, visible
  target service/path, exact approval phrase, and a final review pane.
- **One IA across desktop and mobile.** Desktop may show a left rail and two-pane
  sections; mobile uses the same sections as accordions or tabs, not a different
  mental model.
- **All auth states keep account escape hatches.** Preserve the documented
  account email and sign-out/switch-account affordances across loading, denied,
  sign-in, and allowed states.

## Proposed top-level structure

### App shell

Desktop (`>= 960px`):

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Brain Control Plane  instance: local-brain  codex-chat: ok  [↻] [user ◯] │
├──────────────┬─────────────────────────────────────────────────────────────┤
│ Overview     │ Status cards                                                │
│ Slack        │ Section content                                             │
│ Manifest     │ Context panel / recent audit rail when helpful              │
│ Env & Config │                                                             │
│ Deploy       │                                                             │
│ Audit        │                                                             │
│ Advanced     │                                                             │
└──────────────┴─────────────────────────────────────────────────────────────┘
```

Mobile (`< 960px`):

```text
┌──────────────────────────────┐
│ Brain  [health dot] [user ◯] │  sticky compact header
│ local-brain / codex-chat     │  one-line status strip
├──────────────────────────────┤
│ [Overview][Slack][Manifest]… │  horizontally scrollable tabs or menu button
├──────────────────────────────┤
│ One-column cards             │
│ Accordions for detail        │
│ Sticky bottom action only    │  only inside staged forms, never global restart
└──────────────────────────────┘
```

Header requirements:

- Compact title: “Brain”. Subtitle/pill: `local-brain · codex-chat.service`.
- Status chips: Brain auth configured, codex-chat health, Slack Events URL,
  restart-required count.
- Primary action: Refresh.
- User icon/avatar button opens an account menu with current Clerk email,
  “Account page”, and “Sign out / switch account”. The email remains visible in
  denied/loading states via the existing auth UX rules.
- Do not put deploy/restart in the global header; keep dangerous actions in the
  Deploy section only.

### Navigation sections

1. **Overview**
   - Summary cards:
     - Brain service/auth: ok/fail-closed/missing config.
     - codex-chat target: host/IP/path/service/env file.
     - Slack readiness: Events URL, env presence count, manifest render status.
     - Deployment state: deploy command configured, restart command target,
       last operation status.
     - Audit/logs: last successful write, last failed operation, recent denied
       auth/action when available.
   - Each card links to its owning section.
   - Raw `/health` and `/settings` JSON is hidden in “Advanced details”.

2. **Slack**
   - Split into subcards:
     - **Events endpoint:** public URL, upstream owner (`codex-chat`), copy
       button, validation status.
     - **Required settings:** table of `CODEX_CHAT_SLACK_ENABLED`,
       `CODEX_CHAT_BASE_URL`, `CODEX_CHAT_SLACK_EVENTS_PATH`,
       `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, optional `SLACK_APP_TOKEN`.
       Columns: key, purpose, required/optional, present/not set, secret flag,
       action.
     - **Write Slack settings:** progressive drawer/dialog opened from “Update
       settings”; fields are empty every time, have visible labels, helper text,
       and per-key presence notes. Approval phrase `write Slack settings` is
       shown as copyable text and must be typed or pasted.
   - After success: clear inputs, show success alert, mark affected keys present,
     and add a restart-required banner linking to Deploy.

3. **Manifest**
   - Default collapsed summary:
     - Renderer path.
     - Request URL.
     - Events path.
     - Last rendered time/result.
     - Buttons: Render/validate, Copy JSON, Download JSON.
   - Expandable “View manifest JSON” panel with line-wrapped readonly code view.
   - Optional “Edit draft” affordance opens a local, unsaved editor for operator
     experimentation only. Label it clearly: “Draft only — codex-chat remains
     source of truth.” Provide Copy draft and Download draft, not Save, until a
     future API explicitly supports manifest patch proposals.
   - Mobile: keep JSON collapsed by default; full-screen code drawer if expanded.

4. **Env & Config**
   - Primary view is a dense metadata table, not raw JSON:
     - key, category, required/optional, secret-ish, present, source file,
       restart required, last write/audit id when available.
   - “Write env entry” is an advanced drawer, with key selection constrained to
     allowlisted keys where possible. Keep a free-form allowlisted escape hatch
     only under Advanced.
   - Show config file path and ownership metadata; do not attempt rich TOML edit
     until an API can validate and diff config safely.

5. **Deploy / Restart**
   - **Plan first:** the default panel runs `plan codex-chat.service` and renders
     target instance, service, paths, commands, and side effects in a redacted
     review card.
   - **Restart:** disabled until either the operator runs a plan in the current
     page session or explicitly opens “Run without fresh plan”. Requires exact
     `restart codex-chat.service`, displays target service/path, and reminds that
     this must not target `brain-admin.service` or the current codex-chat parent
     subagent process.
   - **Deploy:** visible but secondary; show “not configured” clearly when
     `BRAIN_CODEX_CHAT_DEPLOY_COMMAND` is absent. When configured, require plan,
     build/smoke results when available, exact approval, and final review.
   - Always show command output in redacted, collapsible logs with status,
     duration/timed-out state, and audit id.

6. **Audit / Logs / Status feedback**
   - Add a persistent “Recent activity” rail/list using available audit data when
     an API exists; until then, collect current-page actions client-side and link
     to raw API responses.
   - Feedback hierarchy:
     - global status strip for current auth/health/operation state;
     - section-level alert for validation/action result;
     - inline field errors for form mistakes;
     - collapsible raw response for debugging.
   - Use `role="status"` for success/advisory messages and `role="alert"` for
     blocking errors.

7. **Advanced**
   - Raw `/health`, `/settings`, `/slack/settings`, and operation responses.
   - Generic env/config write escape hatch.
   - Repo-registry read-only blocks and any future manifest/config raw editors.
   - This section is not the first screen and should be safe to ignore during
     daily operation.

## Responsive behavior details

- Use one semantic navigation list and one section model. Desktop renders it as a
  sticky left rail; mobile renders it as a top tab strip or menu drawer.
- Cards become one column below the tablet breakpoint. Summary cards keep a
  compact `label · value · status` format to avoid excessive vertical scrolling.
- Metadata tables collapse to key/value rows on narrow screens; the first row
  always includes the status badge and primary action.
- Dangerous forms use full-width controls on mobile and require the approval
  phrase field to remain near the final Run button.
- Manifest JSON, raw JSON, and command logs are collapsed by default on mobile.
- Header stays sticky; left rail does not. Refresh and account menu remain
  reachable without scrolling.
- Avoid placeholder-only guidance. Every input gets a visible label and helper
  text, with placeholders used only as examples.


## Initial Slack setup wizard plan

This plan now includes only the initial wizard shape. Further instructions are
coming for both the broader admin UI redesign and the Slack setup wizard
redesign, so implementation should not overfit final layouts or copy yet.

The first Slack setup wizard should organize the existing Brain-safe operations
into a sequential checklist:

1. **Confirm target** — show Brain instance, codex-chat checkout/service, env
   file, and the public Brain Events URL.
2. **Render manifest** — call the existing Brain endpoint that renders the
   codex-chat-owned no-secret manifest, then offer copy and download actions.
3. **Slack app UI guide** — display concise instructions for creating/updating
   the Slack app from the manifest, reviewing OAuth scopes/events, and installing
   or reinstalling to the workspace.
4. **Secret handoff** — explain where to find **Basic Information → Signing
   Secret** and **OAuth & Permissions → Bot User OAuth Token**, then write them
   as empty, write-only fields using the existing `write Slack settings`
   approval phrase.
5. **Restart semantics** — after env writes, show restart-required state and
   route to the plan-first `codex-chat.service` operation flow. The wizard must
   not restart `brain-admin.service` and must keep codex-chat restart deliberate.
6. **Live canaries** — checklist public mention, DM, private channel, and MPIM
   canaries, with success/failure notes stored only as non-secret status.
7. **Finish/metadata** — summarize non-secret install metadata: workspace/team
   ID, app ID, bot user ID, scopes/events, Events URL, install/reinstall date,
   and canary outcomes.

The wizard should link to `docs/slack-setup-runbook.md` as the canonical
operator checklist until the redesign instructions are finalized.

## Implementation rollout plan

### Phase A — IA and shell without API changes

- Refactor `renderBrainAdminPage` into smaller string/render helpers inside
  `apps/web/src/admin-page.ts` or a nearby module, while keeping the existing
  no-build-framework approach.
- Add semantic landmarks: header, nav, main, sections, status region.
- Replace raw first-screen JSON with derived summary cards and keep raw payloads
  in Advanced accordions.
- Add the account icon/menu while preserving visible email/switch-account paths
  required by `docs/brain-admin-service.md`.
- Keep all existing endpoint calls and approval phrases unchanged.

### Phase B — settings and manifest ergonomics

- Convert Slack settings to a table plus update drawer/dialog.
- Add restart-required alert after env/Slack writes and link it to Deploy.
- Collapse manifest by default; add render/copy/download/edit-draft affordances.
- Add mobile-specific CSS for one-column cards, collapsible code/log panels, and
  compact header/nav.

### Phase C — operations and audit feedback

- Make Plan the primary deploy/restart interaction; require plan-before-live in
  client state unless operator explicitly bypasses.
- Add structured redacted result panels for restart/deploy output.
- If an audit read API is added, replace page-local activity with durable recent
  audit records. Until then, label activity as “this browser session”.

### Phase D — tests/smoke updates

- Extend `apps/web/src/admin-service.test.ts` render assertions for:
  - header/account menu text;
  - section labels/navigation;
  - manifest collapsed affordances;
  - Slack write-only labels and restart-required feedback text;
  - deploy/restart approval copy.
- Extend `apps/web/smoke/admin-signin-smoke.mjs` to check account menu access,
  sticky header basics, and at least one mobile viewport path.
- Add a no-secret assertion over rendered HTML and captured browser text for
  known fake secret values.

## Acceptance criteria for implementation

- The first desktop viewport shows instance identity, account menu, health/status
  summary, Slack readiness, and restart-required state without scrolling.
- The first mobile viewport shows compact header, current section/nav access,
  account menu, and at least one clear status summary without exposing raw JSON.
- Slack settings are grouped by purpose with presence-only statuses; secret
  fields are never prefilled and are cleared after write attempts.
- Manifest rendering offers copy/download from the collapsed summary and exposes
  JSON only on demand; any edit affordance is clearly draft-only.
- Restart/deploy controls are not visible as casual global actions; they live in
  Deploy, are plan-first, and keep exact approval strings.
- All operation/env/Slack writes keep existing server-side approval, redaction,
  self-service refusal, and audit semantics.
- Denied, loading, signed-in, and sign-in states still show or offer account
  switching.
- Raw JSON/debug output remains available under Advanced for operators, but it is
  not the primary UI.

## 2026-06-27 integrated state-aware operator console implementation plan

Status: implemented. The current admin page includes the state-aware mode panel, Slack Setup Mode, Mission Control, grouped Slack settings, collapsed manifest affordances, plan-first deploy/restart controls, mobile tabs, and updated render/smoke coverage. Future live callback/test-event telemetry is intentionally not implemented yet; see the future-work plan in `plans/brain-control-plane.md`.

This update integrates the attached **State-Aware Operator Console Redesign Plan**
with the existing Brain admin/control-plane plans (`plans/brain-control-plane.md`,
`plans/slack-company-brain-runtime.md`, and this admin UI redesign plan) without
changing Brain/codex-chat ownership boundaries or server-side API/security
semantics.

### Boundary commitments

- Brain continues to own the Clerk-protected `/admin` operator console,
  settings-management UX, write-only env/Slack settings handoff, plan-first
  deploy/restart UI, and Slack setup runbook/wizard wrapper.
- `codex-chat` continues to own Slack signature verification, runtime event
  normalization, adapter behavior, and the no-secret Slack manifest contract that
  Brain renders from the checked-out `codex-chat` script.
- This implementation is UI/client-only except tests/docs. It must not expose
  secret values, persist skip/dismiss state, relax exact approval strings, add
  new mutating APIs, or restart `codex-chat`/`codex-chat` parent processes.
- Current APIs only expose presence metadata, not live Slack callback/test-event
  verification. The UI therefore derives `not_configured`, `partial`, and
  `verified` from required Slack env presence, and labels live callback/test-event
  verification as manual/diagnostic until a future Brain API exists. `degraded`
  remains a future state once durable verification telemetry exists.

### State model and default view

Client state on each page load:

```txt
skipped_for_session = false
slack_state = derive from required Slack settings presence:
  none present       -> not_configured
  some missing       -> partial
  all required set   -> verified
```

Default view logic:

```txt
if slack_state in {not_configured, partial} and !skipped_for_session:
  show Slack Setup Mode as the dominant primary panel
else:
  show Mission Control Mode as the dominant primary panel
```

`Skip Slack for now` sets only the in-memory `skipped_for_session` flag and
switches to Mission Control. It is intentionally not written to localStorage,
sessionStorage, server state, env files, or audit logs; a reload restores the
Slack wizard when setup is still incomplete.

### Page structure implemented

1. [x] **Persistent header**
   - Keep compact Brain identity, target service/host, status chips, refresh, and
     account menu/switch-account affordance.
   - Keep dangerous actions out of the global header.

2. [x] **Primary state / next-action panel**
   - Add a dominant `#mode-panel` immediately below the header/status strip.
   - Show Slack setup required/partial/connected copy, current mode, primary and
     secondary actions, details link, and session skip status.
   - Use green/yellow/red/blue/gray status semantics; only required missing
     values should feel urgent.

3. [x] **Slack Setup Mode**
   - Add a checklist-style wizard section using existing safe controls:
     public base URL/events URL confirmation, secret presence handoff,
     manifest render/copy/download, Slack app install checklist, verification
     diagnostics, live canary guidance, and restart-if-needed link.
   - Wizard fields remain write-only and empty; the canonical runbook remains
     `docs/slack-setup-runbook.md`.

4. [x] **Mission Control Mode**
   - Add a `Mission Control` section that summarizes system health, Slack health,
     runtime config, deploy/restart state, recent activity, and debugging links.
   - Existing Overview/Slack/Manifest/Env/Deploy/Audit/Advanced sections remain
     available as progressively disclosed drill-downs.

5. [x] **Slack settings table**
   - Reorganize rows by Public routing, Slack credentials, and Feature flags.
   - Translate presence into operator states: `required_missing`,
     `required_present`, `optional_missing`, `secret_present`, and
     `verified/presence_only` where applicable.
   - Include recommended action text instead of raw “not set” only.

6. [x] **Deploy/restart safety**
   - Preserve existing plan-first client state, live-operation confirmation modal,
     exact server-side approval semantics, redacted command/log display, and
     Brain self-service refusal.
   - Do not add any global restart shortcut.

7. [x] **Tests/smoke**
   - Extend render assertions for state-aware mode panel, Slack skip button,
     wizard checklist, Mission Control nav/section, grouped Slack settings, and
     no-secret rendering.
   - Extend Playwright smoke to check the Slack setup default, skip-for-session
     transition, Mission Control section, mobile tabs, and account menu.
   - Run `pnpm run check` and `pnpm run smoke:admin-signin`.

### Acceptance criteria for this implementation slice — completed

- [x] Reloading the page with incomplete Slack setup defaults to Slack Setup Mode.
- [x] Clicking `Skip Slack for now` switches to Mission Control without persistence.
- [x] When required Slack settings are all present, Mission Control is the default.
- [x] Operators can still reach raw `/health`, `/settings`, `/slack/settings`, and
  last response under Advanced.
- [x] Slack and env writes remain presence-only/write-only, clear input values after
  attempts, and display restart-required guidance.
- [x] Plan/restart/deploy use the existing `/api/admin/brain/codex-chat/operation`
  contract with no weakened approval or redaction semantics.

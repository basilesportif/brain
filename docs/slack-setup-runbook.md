# Slack setup and install runbook

Date: 2026-06-27  
Owner: Brain admin/control plane

Brain owns the human Slack setup, install, and canary checklist for the active
assistant stack. `codex-chat` remains the runtime owner for the Slack Events API
adapter, request signature verification, event normalization, queuing, and
Slack replies. Brain renders the codex-chat-owned no-secret manifest contract
from the selected `codex-chat` checkout and uses the Brain Events URL as the
public Slack request URL.

Current Brain deployment:

- Brain admin: `https://brain.decisive-outcomes.com/admin`
- Slack Events URL: `https://brain.decisive-outcomes.com/api/slack/events`
- Runtime service: `codex-chat.service`
- Runtime env file: `/home/tim/.config/codex-chat/env`
- Runtime checkout: `/home/tim/pkg/tim/codex-chat`

Do not paste Slack secrets into git, logs, chat transcripts, issue comments, or
manifest files. Brain admin APIs expose env values as write-only presence
metadata only.

## What Slack is being configured to do

The current Slack app uses Slack's HTTP Events API:

1. Slack sends signed HTTPS requests to the Brain Events URL.
2. Caddy/Brain routing forwards the raw body and Slack signature headers
   unchanged to codex-chat's `/api/slack/events` handler.
3. codex-chat verifies Slack signatures with `SLACK_SIGNING_SECRET`, fast-acks
   Slack, deduplicates/retries safely, normalizes events into runtime contexts,
   runs Codex, and replies through the Slack Web API with `SLACK_BOT_TOKEN`.

Required bot scopes for the current adapter:

- `app_mentions:read` — receive channel mentions.
- `chat:write` — post replies to the normalized Slack output target.
- `im:history`, `mpim:history`, `groups:history` — receive DMs, group DMs, and
  private-channel message events.
- `im:read`, `mpim:read`, `groups:read` — resolve/read conversation membership
  metadata for those surfaces when needed.

Subscribed bot events:

- `app_mention`
- `message.im`
- `message.mpim`
- `message.groups`

Slash commands, shortcuts, Socket Mode, and interactive components are not part
of this Phase 2 HTTP Events API setup.

## Brain admin setup flow

Use Brain admin for setup whenever possible:

1. Open `https://brain.decisive-outcomes.com/admin` and sign in with an
   allowlisted Clerk account.
2. In **Slack**, copy the public Events URL. It should be:
   `https://brain.decisive-outcomes.com/api/slack/events`.
3. In **Manifest**, render the Slack manifest. The admin service calls the
   checked-out codex-chat manifest renderer and injects Brain's Events URL.
4. Use **Copy JSON** or **Download JSON**. The rendered manifest contains no
   Slack secrets.
5. After Slack install, return to **Slack** and write the signing secret and bot
   token through the write-only Slack settings form.
6. After env writes, run a codex-chat plan/restart from Brain admin's operation
   flow, or ask the main operator to restart `codex-chat.service` after this
   documentation work completes. Do not restart codex-chat from a child subagent.

Brain write semantics:

- Slack settings writes require exact approval phrase `write Slack settings`.
- Generic env writes require `write env` or `write codex-chat.service env`.
- Secret fields are never prefilled, are cleared after write attempts, and are
  returned only as present/not-present metadata.
- Writing `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `CODEX_CHAT_SLACK_ENABLED`,
  `CODEX_CHAT_SLACK_EVENTS_PATH`, or `CODEX_CHAT_BASE_URL` changes the runtime
  env file but does not affect the running codex-chat process until restart.
- Restart requires exact approval phrase `restart codex-chat.service` and must
  target `codex-chat.service`, never `brain-admin.service`.

Required runtime env values for the current deployment:

```text
SLACK_SIGNING_SECRET=<from Slack Basic Information>
SLACK_BOT_TOKEN=<from Slack OAuth & Permissions, begins xoxb->
CODEX_CHAT_SLACK_ENABLED=true
CODEX_CHAT_SLACK_EVENTS_PATH=/api/slack/events
CODEX_CHAT_API_ENABLED=true
CODEX_CHAT_BASE_URL=https://brain.decisive-outcomes.com
```

`SLACK_APP_TOKEN` is optional and not required for the current HTTP Events API
adapter.

## Slack UI install steps

Use these steps for first install or manifest updates:

1. Go to <https://api.slack.com/apps>.
2. Choose **Create New App** for a new app, or open the existing app for an
   update.
3. For a new app, choose **From an app manifest**.
4. Select the target workspace, currently **Decisive Outcomes**.
5. Choose **JSON** if Slack asks for the manifest format.
6. Paste the Brain-rendered manifest JSON, or upload the downloaded JSON file.
7. Review the summary. Confirm the Events URL is exactly
   `https://brain.decisive-outcomes.com/api/slack/events`.
8. Click **Create** / **Save Changes**.
9. Open **OAuth & Permissions** and click **Install to Workspace** or
   **Reinstall to Workspace** if Slack says scopes changed.
10. Approve the requested bot scopes.
11. Open **Event Subscriptions** and verify Slack accepts the request URL.
12. If using private channels, invite the bot to each private channel with
    `/invite @<bot name>`.

For existing apps, update **App Manifest**, save, then reinstall if Slack reports
new scopes or event subscriptions.

## Where to find Slack secrets

After installing to the workspace:

- `SLACK_SIGNING_SECRET`: Slack app **Basic Information** → **App Credentials**
  → **Signing Secret**.
- `SLACK_BOT_TOKEN`: Slack app **OAuth & Permissions** → **Bot User OAuth
  Token**. It starts with `xoxb-`.

Copy each value once into Brain's write-only Slack settings form. Do not store
these values in the rendered manifest, install metadata JSON, git, or chat.

## Non-secret install metadata

Keep non-secret Slack installation metadata in Brain/private ops records, not in
codex-chat source. Useful fields include:

- workspace/team name and ID;
- Slack app ID and bot user ID;
- installer/admin contact;
- installed scopes and subscribed events;
- rollout channels/private channels;
- Events URL and manifest render timestamp;
- date installed/reinstalled and reason for change.

The codex-chat checkout still contains an example metadata schema in
`slack-app/install-metadata.example.json`; treat it as a contract/template, not a
place to write real deployment state.

## Restart and health verification

After Brain writes env values or the manifest/scopes change, codex-chat must be
restarted before live Slack verification. In Brain admin, use the plan-first
operation flow:

1. Run **Plan** with approval `plan codex-chat.service`.
2. Review target path, service name, command, and redacted side effects.
3. Run **Restart** with approval `restart codex-chat.service`.
4. Confirm the service becomes active and Brain/codex-chat health is green.

If Slack cannot verify the Events URL after restart, verify without printing
secrets:

- Brain/Caddy routes `/api/slack/events` to codex-chat's API listener.
- codex-chat is listening on the expected local port.
- `CODEX_CHAT_SLACK_EVENTS_PATH` is `/api/slack/events`.
- `CODEX_CHAT_BASE_URL` is `https://brain.decisive-outcomes.com`.
- Slack's manifest request URL exactly matches the Brain Events URL.
- The signing secret was copied from **Basic Information**, not from OAuth.

## Live Slack canary checklist

Run these from Slack after restart:

1. **Public channel mention** — mention the bot:
   `@Codex Chat canary: reply with the current UTC time and the word slack-canary`.
2. **Direct message** — DM the bot with the same canary prompt.
3. **Private channel** — invite the bot with `/invite @Codex Chat`, then send a
   canary mention/message in the private channel.
4. **MPIM/group DM** — include the bot in a group DM and send the canary prompt.

For each canary, confirm:

- Slack receives a timely reply in the correct channel/thread/DM.
- codex-chat logs show accepted Slack event delivery, not signature rejection.
- event normalization identifies the correct team/channel/user/thread.
- runtime dispatch completes and `chat.postMessage` succeeds.
- no raw Slack tokens or signing secrets appear in logs, browser responses, or
  copied troubleshooting output.

If delivery fails, check Slack **Event Subscriptions** retry/error details,
Brain/codex-chat health, and codex-chat journal lines around the Slack
component, keeping all secret values redacted.

## Troubleshooting quick map

- **URL verification fails** — check Caddy route, service port, exact Events URL,
  HTTPS certificate, and restart status.
- **Signing errors** — recopy/rotate the **Signing Secret** into
  `SLACK_SIGNING_SECRET`; do not use the bot token as the signing secret.
- **Bot receives events but cannot reply** — verify `chat:write` is installed and
  `SLACK_BOT_TOKEN` is the `xoxb-` bot token.
- **Private channel events missing** — invite the bot and verify
  `message.groups`, `groups:history`, and `groups:read` are installed.
- **DM/MPIM events missing** — verify `message.im`, `message.mpim`, `im:*`, and
  `mpim:*` scopes/events are installed and the app was reinstalled.
- **Manifest render looks wrong** — render from Brain admin again and confirm the
  request URL uses `brain.decisive-outcomes.com/api/slack/events`.
- **Secret leaked** — stop sharing output, rotate the leaked Slack credential in
  Slack, write the new value through Brain, restart codex-chat, and invalidate
  any copied logs/transcripts where possible.

## Future Slack setup wizard

The current Brain admin UI exposes the pieces separately: Slack settings,
manifest render/copy/download, env writes, and operations. The planned wizard
should make the same safe sequence explicit:

1. Confirm Brain instance and runtime target.
2. Show/copy Brain Events URL.
3. Render/copy/download the codex-chat-owned manifest.
4. Guide Slack UI app creation/update and install-to-workspace.
5. Prompt for signing secret and bot token as write-only values.
6. Plan and restart codex-chat after env writes.
7. Run and record the live canary checklist.

Further instructions are coming for both the broader Brain admin UI redesign and
the Slack setup wizard redesign. Until those arrive, keep this runbook as the
canonical user-facing Slack setup checklist and keep codex-chat limited to
runtime, adapter, and manifest contract docs/scripts.

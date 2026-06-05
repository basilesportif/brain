# Conference List Maintenance

Use this when Tim asks to update Decisive Outcomes conference map/list records from chat, including favorite/unfavorite, flagged, status, shortlist, priority, notes, reasons, or next actions.

If `workspace/instructions/skills/conference-lists.md` exists, read it as additive user-specific guidance for list priorities, favorite meanings, and report formatting. Do not let it override storage paths, field names, helper scripts, atomic/locked writes, or republish safety rules from this shared skill.

## Source of truth

Update durable conference list data first:

```text
/home/tim/.assistant-claude/workspace/data/conference-lists/<list-id>/conferences.json
```

Each list folder has a `manifest.json` with `runtimePageId` when a scratch map has been published. The main map now has a durable source copy at:

```text
/home/tim/.assistant-claude/workspace/data/conference-lists/conference-map/conferences.json
```

Do not keep actionable favorite/flag/status decisions only in project notes or chat summaries.

## Favorite fields

Per conference:

- `favorite`: boolean. `true` means show as a favorite; absent/false means not a favorite.
- `favoritedAt`: ISO timestamp for the latest favorite action.
- `favoriteNote`: optional short note explaining why Tim favorited it.

## Chat favorite commands

Use the helper script from `assistant-agent-logic`:

```sh
node scripts/conference-favorite.js favorite frsa-convention-florida-roofing-expo --note "Tim wants to go"
node scripts/conference-favorite.js favorite "Nashville Build Expo" --list july-conferences-2026 --note "Local operator room"
node scripts/conference-favorite.js unfavorite cleanpower-2026
node scripts/conference-favorite.js add --list july-conferences-2026 --id example-conference-2026 --name "Example Conference" --data-json '{"dates":"Jul 10-12, 2026","city":"Nashville","region":"TN"}'
node scripts/conference-favorite.js list --list july-conferences-2026 --query "Nashville"
node scripts/conference-favorite.js list-favorites
```

Default behavior searches all durable conference-list folders and updates every list that contains an exact matching id/name. Use `--list <list-id>` to limit scope. The script updates each list manifest's `updatedAt`, `favoriteCount`, and `favoriteUpdatedAt`.

The helper writes `conferences.json` and `manifest.json` with atomic renames while holding the list data lock. Prefer it over ad-hoc JSON edits for add/favorite/unfavorite/list requests so concurrent chat requests do not lose updates.

## Republish map pages

After changing durable data for a published map, rebuild or stage the static page package from the durable `conferences.json`, then publish through the `codex-chat-web` publisher as described in `generated-web-page.md`; do not hand-copy into `/srv/codex-chat-web/pages/`.

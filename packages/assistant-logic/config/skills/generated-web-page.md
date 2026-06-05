# Generated Web Page Skill

Use this skill when Tim asks to create, publish, or share a generated webpage, interactive static page, simple data visualization, mockup, report, chart, table, calculator, small tool, Google Maps-style static page, one-off scratch page, or other browser-viewable HTML/CSS/JS artifact. Phrases like "scratch page", "temporary page", "private preview page", "quick page", or "one-off page" route here even when Tim does not name the configured scratch host; default to publishing through `codex-chat-web` using the publisher's configured public base URL unless Tim asks otherwise.

Use this skill, not `config/skills/web-page-design.md`, when Tim asks for a simple data visualization, map, report, chart, table, calculator, one-off scratch page, temporary page, private preview page, quick page, or other functional static page, unless he explicitly asks for a serious visual redesign, design system, or real site design.

Do not use this skill as the first stop when Tim is primarily asking for real site or page visual design work: a new visual/product design from scratch, visual redesign, brand direction, design system, landing-page design, homepage design, app-page design, or design mockup. Use `config/skills/web-page-design.md` first for the design brief, visual direction, reference analysis, screenshots, critique, and improvement pass. If that design work needs a static webpage after the direction is locked, return here for packaging and publishing.

The `codex-chat-web` publisher is the source of truth for scratch page URLs: `CODEX_CHAT_WEB_PUBLIC_BASE_URL` may override `DEFAULT_PUBLIC_BASE_URL` in `scripts/lib/generated-pages.mjs` (currently Tim's local default is `https://me.galebach.com/pages`). Treat that configured host as an on-demand static HTML/CSS/JS scratch page host, not a dashboard. Default generated pages are unlisted scratch URLs under `/pages/<id>/` with TTL/pruning. Request-specific pages are not committed to source repos unless Tim explicitly promotes the implementation.

## Repository Authority

Before touching any repo or runtime path, resolve the authoritative location from:

```text
/home/tim/.assistant-claude/workspace/.claude/repo-registry/index.yaml
```

Current ownership:

- `codex-chat-web` owns the publisher, pruner, tooling, Caddy docs, and generic shared page-host code only.
- `assistant-agent-data` owns `data/web-pages/manifest.json` metadata.
- Generated scratch page files are artifacts, not source code. Keep request-specific pages outside durable repos unless Tim explicitly asks to promote the implementation.

For remote registry entries, inspect and run commands over SSH on the registered host/path. Do not substitute same-looking local paths.

## Build Rules

1. Build the page package in the task workspace or subagent artifact directory.
2. The package must contain `index.html` at its root.
3. Keep it static-only: HTML, CSS, browser JavaScript, images, fonts, and static data files.
4. Do not include server code, env files, credentials, cookies, private tokens, package manager caches, `.git`, `node_modules`, or generated scratch files unrelated to the page.
5. For interactive pages, run a local browser or static-server smoke test when practical, and fix uncaught console errors.
6. For visual work, check mobile and desktop viewports when the page is intended for general viewing.

## Project-Specific Visual Defaults

These defaults apply only when the requested generated page is clearly for Tim's Decisive Outcomes / IT Consulting Firm project: Decisive Outcomes, IT Consulting Firm, AIOps Audit, Map & Wrap, conference planning for that project, industry briefs, operator workflow maps, or related consulting proof artifacts. Do not apply this visual system to unrelated users, Mush work, generic scratch pages, or other Tim projects unless Tim explicitly asks.

For Decisive Outcomes / IT Consulting generated pages, use the Native Node-inspired briefing system by default:

- Visual identity: cinematic, minimal, premium, technical, and private-executive-briefing-like, not a generic consulting landing page.
- Palette: near-black `#0a0a0a`, white `#fafafa`, gold `#c9a227`, dim gold `#8a7119`, restrained dark panel surfaces, and low-opacity white text levels. Gold is the signal/linework layer, not a full luxury wash. Do not substitute cream text or a beige/gold palette.
- Typography: load Space Mono and Instrument Serif from Google Fonts when the page can use external font resources. Use Space Mono for body, UI, labels, metadata, controls, maps, and technical text. Use Instrument Serif, with Georgia as fallback, for expressive headings, brief titles, and high-trust pull lines.
- Geometry: 4px radius, thin 1px borders, fine gold dividers, corner ticks, etched frames, compact labels, and precise linework. Avoid oversized rounded cards, pill-heavy controls, glossy surfaces, and nested card stacks.
- Background and ornament: black canvas with faint gold technical grid or linework, restrained glow, and sparse technical framing. Avoid decorative blobs, bokeh, generic purple/blue AI gradients, chip/neural wallpaper, robot imagery, and stock business photos.
- Map and briefing patterns: put the map, workflow, or primary artifact first. Keep controls compact and meaningful. Use dark panels, gold dividers, small uppercase metadata, concise source/status rows, workflow step frames, and clear exception/fit/talk-track sections.
- Conference pages: design mobile first because Tim may use them live at conferences. Use readable type at arm's length, compact touch controls, slide-out drawers or bottom sheets for event lists, no tiny fixed side chrome on mobile, no text overflow, and fast access to filters, status, source links, and next actions.
- Industry briefs: lead with the industry/conference identity, a short operator read, why Decisive Outcomes fits, a workflow map, systems/pain/revenue/cost sections, conference conversation starters, and sources. Keep it editorial and precise rather than salesy.
- Motion: use quiet fades, line drawing, panel reveals, subtle map/list transitions, and controlled scroll/progress. Avoid autoplay or motion that takes control away from the presenter.
- Authorship: if Tim's photo or identity appears, use it as a trust/authorship signal. A large portrait belongs only in an opening or closing briefing frame; otherwise use a small signature strip, avatar medallion, or host label.
- Avoid: generic SaaS hero sections, fake dashboards, fake quantified ROI, fake client logos, unsupported claims, stock meeting photos, pricing tables, productized SaaS posture, old TechQora residue, and any change to current AIOps Audit / Map & Wrap positioning unless Tim explicitly changes the strategy.

The current IT Consulting project notes already contain the canonical Decisive Outcomes visual direction, Native Node token extraction, Conference Map guidance, and FRSA industry brief content. Use those project notes as source context when available, but keep generated scratch page implementations outside durable repos unless Tim promotes them.

For conference map/list pages, update durable source data first under `workspace/data/conference-lists/<list-id>/conferences.json` using `config/skills/conference-lists.md` when Tim is asking to favorite, shortlist, flag, reprioritize, add, or remove conference records. Republished scratch pages must be rebuilt from that durable source; do not encode favorite/list decisions only in a generated page artifact.

## Google Maps API Key

For Google Maps-style pages, the assistant runtime host stores the browser Maps JavaScript API key in:

```text
/home/tim/.config/codex-chat-web/env
```

Use the variable name `GOOGLE_MAPS_API_KEY`. Load it only in the shell that needs to build or publish the generated page, and verify it without printing the value:

```sh
test -r /home/tim/.config/codex-chat-web/env
set -a
. /home/tim/.config/codex-chat-web/env
set +a
test -n "${GOOGLE_MAPS_API_KEY:-}"
```

Do not echo the value, include it in command arguments, write it to docs, source repos, manifests, or source metadata, or commit the env file. Static browser pages that load the Google Maps JavaScript API may necessarily expose the browser key to viewers of the generated page; keep those artifacts scratch/TTL-bound unless Tim explicitly promotes them.

## Publish

Use the `codex-chat-web` publisher. Do not hand-copy files into `/srv/codex-chat-web/pages/`, and do not treat the host as a dashboard deployment.

From the authoritative `codex-chat-web` checkout, publish with:

```sh
npm run publish:page -- --dir /path/to/static-page --title "Page title"
```

Useful options:

```sh
--id <stable-id>
--ttl-hours <hours>
--promoted
--source-agent codex
--job-id <subagent-job-id>
--request-id <request-id>
--artifact-path <source-artifact-path>
--runtime-root /srv/codex-chat-web/pages
--manifest-path /home/tim/.assistant-claude/workspace/data/web-pages/manifest.json
```

Defaults are a 24 hour TTL, `private-link` visibility, scratch status, `/srv/codex-chat-web/pages/<id>/` runtime placement, and unlisted public URLs derived from the configured publisher base URL (`CODEX_CHAT_WEB_PUBLIC_BASE_URL` or `DEFAULT_PUBLIC_BASE_URL`, currently `https://me.galebach.com/pages`). Promoted pages have no expiry.

If the publisher host cannot see the source artifact directory, stage the package to a temporary directory on the publisher host first, then run the publisher against that staged copy. If the publisher cannot reach the manifest or runtime path, stop and report the blocker; do not bypass the publisher.

## Verify

After publishing:

1. Read the publisher JSON output and return the public URL.
2. Verify the manifest entry exists and contains the expected `id`, `title`, `createdAt`, `expiresAt`, `ttlHours`, `visibility`, `entrypoint`, `url`, `source`, and `status`.
3. If Caddy is deployed and reachable, smoke-test the returned URL.
4. Report the TTL/pruning or promotion status in the user-facing answer.

## Prune

Expired scratch pages are removed with:

```sh
npm run prune:pages --
```

The pruner deletes expired runtime directories and marks manifest entries `expired`. Do not delete promoted pages unless Tim explicitly asks.

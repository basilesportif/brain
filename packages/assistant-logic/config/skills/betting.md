# Sports Betting Tracker

Records, tracks, and summarizes the user's sports bets. Every bet is stored with full unit math so ROI/P&L can be computed by sport, league, platform, month, or other filters. Currency display preferences belong in the workspace overlay; the shared default is to record units and avoid currency unless the user asks for it or currency is needed to infer units.

**Storage**: `workspace/data/bets.json` (atomic writes via `scripts/lib/state-stores.js`). Never write this file directly; always go through the scripts below.

**Workspace overlay**: `workspace/instructions/skills/betting.md` may add user-specific preferences (default platform, default units, sport/league aliases). Overlay is additive only — it may refine priorities or style, but must never redefine commands, storage paths, approval requirements, or safety rules.

**Entry preferences prompt**: `config/prompts/bet-entry-preferences.md` documents the preference slots; actual values live in `workspace/instructions/prompts/bet-entry-preferences.md`.

## Trigger patterns

When any of these match, follow the relevant workflow below.

### Entry triggers

- Words: "bet", "parlay", "leg"
- American odds: `-\d{3,4}` or `+\d{3,4}` with no currency prefix (`-110`, `+347`, `-141`)
- Units suffix: `\d+(\.\d+)?u` (`2.5u`, `1u`, `0.75u`, possibly followed by `risk` or `to win`)
- Spread notation: `(-3.5)`, `(+9.5)` adjacent to team names
- Total notation: `o\d+(\.\d+)?`, `u\d+(\.\d+)?` (`o2.5`, `u217.5`)
- Moneyline marker: `(ML)`
- Platform names: Bet105, Bet 105, DK, DraftKings, FD, FanDuel, MGM, BetMGM, Caesars, Pinnacle, Fanatics
- Team + market combo: `<team> vs <team>` plus any of the above

### Screenshot triggers

Any image attachment showing a sportsbook bet slip — sportsbook logo, "My Bets", "Open Bets", "Place Bet", "Potential Payout", "Potential Winnings", odds in American format. Treat as an entry trigger.

### Voice triggers

Any transcribed voice message matching the entry triggers above. Transcripts often have spelled-out numbers ("minus one oh six" → -106); normalize before parsing.

### Query triggers

- "how am I doing", "P&L", "ROI", "summary", "net units", "win rate", "what's my record"
- Month names + "results" / "ROI" ("April results", "March ROI")
- Sport names + "record" / "ROI" / "results" ("NBA record", "soccer results", "NFL ROI")
- Platform names + "record" / "ROI" ("Bet105 ROI", "how's DK doing")
- "pending bets", "pending bets?", "pending?", "any pending?", "what bets are pending"

### Result-update triggers

Short messages referring to a team that exists in a pending bet:

- `<team> won`, `<team> lost`, `<team> pushed`
- `push on the <team> game`, `voided`
- `+<team>`, `-<team>`
- `cash out <team>` (treat as void unless the user specifies otherwise)

## Entry workflow (5 steps)

Follow these steps for every entry trigger — text paste, screenshot, or voice.

### Step 0 — Ingest

- **Text paste**: use the message body as `raw_input`.
- **Voice**: follow the standard Telegram voice flow (download → `scripts/transcribe-voice.js` → use transcript as text).
- **Screenshot**: Read the image. Extract teams, market + line, odds (American), stake/risk dollars, platform, and result badge if visible. If odds are clearly readable, use those odds. If stake/risk dollars are clearly readable and a unit size is known from the workspace overlay or `workspace/data/bets.json`, infer units from `stake_or_risk_dollars / unit_size_usd`.

### Step 1 — Parse

Use `scripts/lib/bet-parser.js` for a deterministic first pass, or parse inline if confident. Produce a draft bet object with whatever could be extracted. Leave unknowns as `null`.

### Step 2 — Use clear odds and stake data

**Do not ask the user to confirm odds or units when the source is clear.** If a screenshot, paste, voice transcript, or incoming data clearly shows American odds, use those odds. If it clearly shows stake/risk dollars and unit size is known (for example, `1u = $100`), infer units from dollars and do not ask for unit confirmation.

Only ask a follow-up when odds, stake, units, or risk type are missing, ambiguous, contradictory, or unreadable. Keep it to one line:

```
Parsed: Pistons vs Magic (+9.5) spread, -106, Bet105
Need stake/units? (e.g. 2.5u risk)
```

If both odds and inferred units are clear, proceed to the consolidated follow-up or echo without asking about them.

### Step 3 — One consolidated follow-up (if needed)

Ask ONE message covering any of these that apply:

- Odds if missing, ambiguous, contradictory, or unreadable
- Units/stake if neither units nor a convertible stake/risk dollar amount is clear
- Result if past-event and not given ("WIN / LOSE / PUSH / PENDING?")
- Platform if missing and not obvious
- Half qualifier if unclear ("Full game or 1H?")
- Sport/league if team names are unfamiliar
- Risk vs to-win only if text mentions "to win"

Do NOT ask about things the parser is confident about.

### Step 4 — Echo before save

Echo the full parsed bet in compact notation, once:

```
Saving:
  2026-04-22, PENDING Pistons vs Magic (+9.5), -106, 2.5u, Bet105
Confirm? (yes / edit)
```

On "edit <field>" or pasted correction, update the draft and re-confirm.

### Step 5 — Save

Dispatch `node scripts/bet-add.js` in a sub-agent with the confirmed fields. Reply with id + compact echo + today's running total:

```
Saved bt_abc123
2026-04-22 PENDING Pistons vs Magic (+9.5), -106, 2.5u, Bet105
Today: 2 bets, 3.0u risked, 0 settled
```

### Parlays

When input contains `&`:

1. Parse each leg (use `parseParlay` in the parser lib).
2. Use combined odds automatically when clearly shown; otherwise ask the user for one combined odds number.
3. Use units automatically when clearly shown or inferred from clear stake/risk dollars and known unit size; otherwise ask the user for combined units.
4. Save with `is_parlay: true`, `parlay_legs: [...]`, and no top-level team/market/line/side.

Echo:

```
Saving parlay (2 legs):
  - o2.5 Frankfurt vs RB Leipzig
  - o2.5 Bayern vs Stuttgart
  2026-04-19, WIN @ -141, 3.1u risk
Confirm?
```

### Multi-bet blocks

If the user pastes a date header + multiple `* BET` lines, use `parseMultiBetBlock`. Echo the full parsed list once, confirm anything ambiguous, then save all with a single `yes`. Reply with the day's rolling total after save.

## Query workflow

When a query trigger fires:

1. Translate the NL input into `bet-summary.js` flags using the mapping table below.
2. Dispatch `node scripts/bet-summary.js <flags> --format telegram` in a sub-agent (Sonnet medium is fine — deterministic).
3. Reply with the Telegram-formatted output.
4. Offer a follow-up breakdown only when the numbers look interesting (one sport far outperforming another, a book significantly down, etc.).

### NL-to-flags mapping

| Trigger | Command |
|---|---|
| "how am I doing in April", "April P&L" | `node scripts/bet-summary.js --month 2026-04 --format telegram` |
| "NBA ROI", "how am I doing in NBA" | `node scripts/bet-summary.js --sport nba --format telegram` |
| "Bundesliga ROI", "soccer this month" | `node scripts/bet-summary.js --month 2026-04 --league bundesliga --format telegram` |
| "Bet105 ROI", "how's Bet105 doing" | `node scripts/bet-summary.js --platform bet105 --format telegram` |
| "April NBA ROI" | `node scripts/bet-summary.js --month 2026-04 --sport nba --format telegram` |
| "year to date", "YTD" | `node scripts/bet-summary.js --since 2026-01-01 --format telegram` |
| "break it down by sport / platform / month" | add `--group-by sport` (or `platform` / `month`) to the previous query |

Rules of thumb:

- Month name → `--month YYYY-MM`.
- Sport bucket ("NBA", "soccer", "NFL") → `--sport`.
- Specific league ("Bundesliga", "UCL", "SEC") → `--league`.
- Book ("Bet105", "DK", "FanDuel") → `--platform` (lowercase alias).
- Combine freely.
- Always pass `--format telegram` for chat replies; use `json` only when piping to another script.

## Pending bets query

When any of the pending bets triggers fire ("pending bets?", "pending?", "any pending?", "what bets are pending", "pending bets"), run the auto-settle workflow below as a **background sub-agent** (`run_in_background: true`). ACK immediately ("Checking pending bets…"), then report back when done.

### Workflow

1. Run `node scripts/bet-list.js --result pending --format json` to get all pending bets.
2. If the output is an empty array, reply: "No pending bets."
3. For each pending bet, use **WebSearch** to look up the actual game result. Construct a query like:
   - `<away_team> vs <home_team> <sport> score <date>` (e.g. "Knicks vs Celtics NBA score 2026-04-24")
   - For NBA playoff games, include "2026 NBA playoffs" in the query for specificity.
   - If the date is ambiguous, prefer the most recent result within the expected window.
4. If the game has been played and the final score is determinable:
   - Calculate win/loss/push based on `market`, `line`, `side`, and the actual score:
     - **Spread**: add `line` to the favored team's score (or subtract from underdog) and compare.
     - **Total**: sum both teams' scores and compare to `line` with `side` (over/under).
     - **Moneyline**: compare winner to `side`.
   - Run `node scripts/bet-result.js --id <id> --result <win|lose|push>` to settle the bet.
5. After processing all bets, reply with a one-line summary per bet:

   ```
   ✓ Knicks vs Celtics spread (+5.5) → Celtics won 112-98 → WIN (+2.27u)
   ✓ Thunder vs Warriors o220.5 → 108-104 (212 total) → LOSE (−2.5u)
   ? Heat vs Pacers — no result found yet (game may not have been played)
   ```

6. Note clearly any bets that could not be settled (result not found, game postponed, data ambiguous) so the user can update them manually.

## Result-update workflow

When a result trigger fires:

1. Dispatch `node scripts/bet-list.js --result pending --format json` to enumerate pending bets.
2. Fuzzy-match on team names mentioned in the message.
3. If exactly one match: dispatch `node scripts/bet-result.js --id <id> --result <win|lose|push|void>`. Reply with the updated bet + today's running total.
4. If multiple matches: list them numbered and ask the user which one.
5. If no match: tell the user and ask for the bet id.

`bet-result.js --match "<text>"` can do the fuzzy match in one shot and will exit 2 (ambiguous) with candidates on stderr when >1 pending bet matches — surface the candidates to the user in that case.

## Script reference

All scripts live in `scripts/` and are backed by `scripts/lib/bet-store.js`.

```bash
# Add a single bet
node scripts/bet-add.js --date 2026-04-22 --market spread --side away \
  --home "Pistons" --away "Magic" --line 9.5 --odds -106 --units 2.5 \
  --platform bet105 --sport nba --raw "Pistons vs Magic (+9.5), -106, 2.5u, Bet105"

# Add a parlay
node scripts/bet-add.js --date 2026-04-19 --result win --odds -141 --units 3.1 \
  --risk-type risk --platform bet105 \
  --parlay-legs '[{"home_team":"Frankfurt","away_team":"RB Leipzig","market":"total","side":"over","line":2.5,"half_qualifier":"full","sport":"soccer","league":"Bundesliga"},{"home_team":"Bayern","away_team":"Stuttgart","market":"total","side":"over","line":2.5,"half_qualifier":"full","sport":"soccer","league":"Bundesliga"}]'

# Update a pending bet by id
node scripts/bet-result.js --id bt_abc123 --result win

# Or fuzzy-match by team name (errors with exit 2 if ambiguous)
node scripts/bet-result.js --match "Magic" --result win

# List with filters
node scripts/bet-list.js --result pending --format text
node scripts/bet-list.js --sport nba --since 2026-04-01 --format json

# Summary
node scripts/bet-summary.js --month 2026-04 --format telegram
node scripts/bet-summary.js --sport nba --group-by platform --format telegram

# Delete (by id only — no fuzzy to avoid accidents)
node scripts/bet-delete.js --id bt_abc123
```

Flags `--odds` and `--line` accept negative values because scripts consume the next argv verbatim. `--odds=-110` form is also supported.

## Unit math reference

- Negative odds payout ratio: `100 / abs(odds)` (−110 → 0.909)
- Positive odds payout ratio: `odds / 100` (+347 → 3.47)
- WIN delta: `units * ratio` (positive)
- LOSE delta: `-units`
- PUSH / VOID delta: 0
- PENDING: excluded from P&L unless `--include-pending`
- ROI% = `100 * units_net / units_risked`

## Privacy and commits

`workspace/` is gitignored. Never commit `bets.json`, never log full bet contents in persistent logs.

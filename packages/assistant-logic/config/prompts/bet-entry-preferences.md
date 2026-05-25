# Bet Entry Preferences (Scaffold)

Personal preferences for how the assistant handles sports bet entries. This shared file is a SCAFFOLD — actual values belong in the workspace overlay at `workspace/instructions/prompts/bet-entry-preferences.md` per the CLAUDE.md preference-routing rule.

Each slot below explains a preference the user may set. The overlay should pick one option per slot (or leave blank for the default).

## Default platform

If a bet is logged without a platform name, assume this book. Example overlay: `Default platform: bet105`.

Default when unset: `unknown`.

## Default units

If a bet is logged without a unit size, assume this. Example: `Default units: 1u risk`.

Default when unset: prompt the user for units.

## Default risk mode

Whether bare `Nu` means "units risked" (default) or "units to win".

Default when unset: `risk`.

## Echo-before-save

Whether the assistant must always echo the parsed bet for confirmation before saving, or can save immediately when parse confidence is high (all fields extracted cleanly including odds).

Default when unset: always echo.

## Odds-confirm skip rules

Conditions under which the assistant should ask for odds despite the shared default of using clearly parsed odds automatically. Example: "ask for odds when a screenshot crop cuts off the price" or "ask when pasted odds conflict with screenshot odds".

Default when unset: use clearly shown odds automatically; ask only when odds are missing, ambiguous, contradictory, or unreadable.

## Reply verbosity

Whether save confirmations should be compact (single line) or multi-line with the day's running total. Example: `Reply verbosity: compact`.

Default when unset: multi-line with running total.

## Sport/league aliases

Shortcuts the user uses that should map to canonical sport/league values. Example:

```
footy → soccer
basketball → nba (when no league qualifier)
college ball → cbb
```

Default when unset: no custom aliases (parser defaults only).

## Platform aliases

User-local shorthand beyond the parser's built-in list. Example: `BM → mgm`, `stake → fanatics`.

Default when unset: built-in aliases only.

## Per-sport notes

Free-form notes the assistant should remember when processing bets in specific sports. Example: "For soccer, default `half_qualifier` to `full` unless the user mentions half-time; treat 'over 2.5' as a line even if the user omits the `o`."

## Notification and running-total preferences

- Should the assistant volunteer a day total after each save? After each result update?
- Should weekly or monthly auto-summaries be sent to Telegram on a schedule? If so, when? (This is a reminders/loops concern — configure separately.)

Default when unset: volunteer a day total after save and after result update; no auto-summaries.

#!/usr/bin/env node
/**
 * Add a sports bet to the tracker.
 *
 * Flags:
 *   --date YYYY-MM-DD             required
 *   --result win|lose|push|pending|void   default: pending
 *   --sport nba|nfl|mlb|nhl|soccer|cfb|cbb|mma|tennis|other   optional
 *   --league "NBA"                optional
 *   --market spread|moneyline|total|prop|parlay              required
 *   --side home|away|over|under   required for spread/total/moneyline
 *   --home "Pistons"              required for non-parlays
 *   --away "Magic"                required for non-parlays
 *   --line -8.5                   required for spread/total (numeric, may be negative)
 *   --half full|1h|2h|1q|2q|3q|4q|ht   default: full
 *   --odds -110                   required (American, signed int; negatives are fine)
 *   --units 1.5                   required (decimal)
 *   --risk-type risk|to-win       default: risk
 *   --platform bet105|dk|fanduel|mgm|caesars|pinnacle|fanatics|unknown   default: unknown
 *   --notes "TEXT"                optional
 *   --raw "ORIGINAL TEXT"         optional but recommended
 *   --source telegram-text|telegram-screenshot|telegram-voice|manual   default: manual
 *   --parlay-legs '<JSON array>'  if present, bet is a parlay (top-level --home/--away/--line/--market/--side ignored)
 *
 * Numeric flags (--line, --odds) accept negative values because the parser
 * always consumes the next argv element verbatim. `--odds=-110` is also supported.
 *
 * Output: JSON to stdout on success, errors to stderr.
 * Exit codes: 0 success, 1 usage/validation error.
 */
const { addBet } = require("./lib/bet-store");

// Flags that take a value (as opposed to bare switches).
const STRING_FLAGS = new Set([
  "--date",
  "--result",
  "--sport",
  "--league",
  "--market",
  "--side",
  "--home",
  "--away",
  "--line",
  "--half",
  "--odds",
  "--units",
  "--risk-type",
  "--platform",
  "--notes",
  "--raw",
  "--source",
  "--parlay-legs",
]);

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const token = argv[i];
    // Support --flag=value form
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq !== -1) {
      const flag = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (STRING_FLAGS.has(flag)) {
        args[flag] = value;
      }
      i++;
      continue;
    }
    if (STRING_FLAGS.has(token)) {
      // Consume the next argv verbatim — allows negative numbers.
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for ${token}`);
      }
      args[token] = argv[i + 1];
      i += 2;
      continue;
    }
    i++;
  }
  return args;
}

function normalizeRiskType(value) {
  if (!value) return "risk";
  const v = value.toLowerCase().replace(/-/g, "_");
  if (v === "risk") return "risk";
  if (v === "to_win" || v === "towin") return "to_win";
  throw new Error(`Invalid --risk-type: ${value} (use risk|to-win)`);
}

function normalizeSource(value) {
  if (!value) return "manual";
  const v = value.toLowerCase();
  const allowed = [
    "telegram-text",
    "telegram-screenshot",
    "telegram-voice",
    "manual",
  ];
  if (!allowed.includes(v)) {
    throw new Error(`Invalid --source: ${value}`);
  }
  return v;
}

function main() {
  let rawArgs;
  try {
    rawArgs = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const date = rawArgs["--date"];
  if (!date) {
    console.error(
      'Usage: bet-add.js --date YYYY-MM-DD --market <m> --odds <n> --units <n> [--home T --away T --line N --side S ...]'
    );
    process.exit(1);
  }

  let parlayLegs = null;
  if (rawArgs["--parlay-legs"]) {
    try {
      parlayLegs = JSON.parse(rawArgs["--parlay-legs"]);
    } catch (err) {
      console.error(`--parlay-legs must be valid JSON: ${err.message}`);
      process.exit(1);
    }
    if (!Array.isArray(parlayLegs)) {
      console.error("--parlay-legs must be a JSON array");
      process.exit(1);
    }
  }

  const isParlay = parlayLegs !== null;
  const market = isParlay ? "parlay" : rawArgs["--market"];

  const fields = {
    date,
    result: rawArgs["--result"] || "pending",
    sport: rawArgs["--sport"] || null,
    league: rawArgs["--league"] || null,
    market,
    side: isParlay ? null : (rawArgs["--side"] || null),
    home_team: isParlay ? null : (rawArgs["--home"] || null),
    away_team: isParlay ? null : (rawArgs["--away"] || null),
    line: isParlay
      ? null
      : rawArgs["--line"] !== undefined
        ? Number(rawArgs["--line"])
        : null,
    half_qualifier: isParlay ? "full" : (rawArgs["--half"] || "full"),
    odds_american:
      rawArgs["--odds"] !== undefined ? Number(rawArgs["--odds"]) : undefined,
    units:
      rawArgs["--units"] !== undefined ? Number(rawArgs["--units"]) : undefined,
    platform: (rawArgs["--platform"] || "unknown").toLowerCase(),
    is_parlay: isParlay,
    parlay_legs: parlayLegs,
    raw_input: rawArgs["--raw"] || "",
    notes: rawArgs["--notes"] || "",
  };

  try {
    fields.risk_or_to_win = normalizeRiskType(rawArgs["--risk-type"]);
    fields.source = normalizeSource(rawArgs["--source"]);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (
    fields.line !== null &&
    fields.line !== undefined &&
    !Number.isFinite(fields.line)
  ) {
    console.error(`--line must be numeric, got: ${rawArgs["--line"]}`);
    process.exit(1);
  }

  try {
    const bet = addBet(fields);
    console.log(JSON.stringify({ ok: true, bet }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();

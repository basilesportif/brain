#!/usr/bin/env node
/**
 * List sports bets with optional filters.
 *
 * Flags:
 *   --date YYYY-MM-DD             exact date
 *   --since YYYY-MM-DD            inclusive
 *   --until YYYY-MM-DD            inclusive
 *   --sport nba|...
 *   --league "Bundesliga"
 *   --platform bet105|dk|...
 *   --result pending|win|lose|push|void
 *   --parlays-only                only parlays
 *   --no-parlays                  exclude parlays
 *   --id bt_...                   single bet
 *   --query "Magic"               substring search over teams, raw_input, notes
 *   --limit N                     cap to most-recent N
 *   --format json|text|telegram   default: json
 *
 * Output: JSON array (or compact text) sorted by date ascending, created_at ascending.
 */
const { listBets } = require("./lib/bet-store");

const STRING_FLAGS = new Set([
  "--date",
  "--since",
  "--until",
  "--sport",
  "--league",
  "--platform",
  "--result",
  "--id",
  "--query",
  "--limit",
  "--format",
]);
const BOOL_FLAGS = new Set(["--parlays-only", "--no-parlays"]);

function parseArgs(argv) {
  const args = {};
  let i = 2;
  while (i < argv.length) {
    const token = argv[i];
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq !== -1) {
      const flag = token.slice(0, eq);
      if (STRING_FLAGS.has(flag)) args[flag] = token.slice(eq + 1);
      i++;
      continue;
    }
    if (STRING_FLAGS.has(token)) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${token}`);
      args[token] = argv[i + 1];
      i += 2;
      continue;
    }
    if (BOOL_FLAGS.has(token)) {
      args[token] = true;
      i++;
      continue;
    }
    i++;
  }
  return args;
}

function formatBetCompact(b) {
  const resultStr = (b.result || "pending").toUpperCase();
  const stakeNote = b.risk_or_to_win === "to_win" ? "to win" : "risk";
  const unitsStr = `${b.units}u${b.risk_or_to_win === "to_win" ? " to win" : ""}`;
  const oddsStr = b.odds_american > 0 ? `+${b.odds_american}` : `${b.odds_american}`;
  const platformStr = b.platform && b.platform !== "unknown" ? `, ${b.platform}` : "";

  if (b.is_parlay) {
    const legCount = Array.isArray(b.parlay_legs) ? b.parlay_legs.length : 0;
    let out = `${b.date} ${resultStr} parlay(${legCount}), ${oddsStr}, ${unitsStr}${platformStr}`;
    for (const leg of b.parlay_legs || []) {
      out += `\n  ${formatLegCompact(leg)}`;
    }
    return out;
  }

  let marketPart = "";
  if (b.market === "total") {
    const totalPrefix = b.side === "over" ? "o" : "u";
    const halfSuffix =
      b.half_qualifier && b.half_qualifier !== "full" ? ` ${b.half_qualifier}` : "";
    marketPart = `${totalPrefix}${b.line ?? ""}${halfSuffix} ${b.home_team} vs ${b.away_team}`;
  } else if (b.market === "moneyline") {
    const team = b.side === "home" ? b.home_team : b.away_team;
    marketPart = `${team} (ML) vs ${b.side === "home" ? b.away_team : b.home_team}`;
  } else if (b.market === "spread") {
    const signed =
      b.line !== null && b.line !== undefined
        ? b.line > 0
          ? `+${b.line}`
          : `${b.line}`
        : "";
    if (b.side === "home") {
      marketPart = `${b.home_team} (${signed}) vs ${b.away_team}`;
    } else {
      marketPart = `${b.home_team} vs ${b.away_team} (${signed})`;
    }
  } else {
    marketPart = `${b.home_team} vs ${b.away_team}`;
  }

  return `${b.date} ${resultStr} ${marketPart}, ${oddsStr}, ${unitsStr}${platformStr}`;
}

function formatLegCompact(leg) {
  if (!leg) return "";
  if (leg.market === "total") {
    const prefix = leg.side === "over" ? "o" : "u";
    const halfSuffix =
      leg.half_qualifier && leg.half_qualifier !== "full" ? ` ${leg.half_qualifier}` : "";
    return `${prefix}${leg.line ?? ""}${halfSuffix} ${leg.home_team} vs ${leg.away_team}`;
  }
  if (leg.market === "moneyline") {
    const team = leg.side === "home" ? leg.home_team : leg.away_team;
    return `${team} (ML) vs ${leg.side === "home" ? leg.away_team : leg.home_team}`;
  }
  if (leg.market === "spread") {
    const signed =
      leg.line !== null && leg.line !== undefined
        ? leg.line > 0
          ? `+${leg.line}`
          : `${leg.line}`
        : "";
    if (leg.side === "home") {
      return `${leg.home_team} (${signed}) vs ${leg.away_team}`;
    }
    return `${leg.home_team} vs ${leg.away_team} (${signed})`;
  }
  return `${leg.home_team || ""} vs ${leg.away_team || ""}`.trim();
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const filters = {
    date: args["--date"],
    since: args["--since"],
    until: args["--until"],
    sport: args["--sport"],
    league: args["--league"],
    platform: args["--platform"],
    result: args["--result"],
    parlaysOnly: args["--parlays-only"] === true,
    noParlays: args["--no-parlays"] === true,
    id: args["--id"],
    query: args["--query"],
    limit: args["--limit"] !== undefined ? Number(args["--limit"]) : undefined,
  };

  const format = (args["--format"] || "json").toLowerCase();

  try {
    const bets = listBets(filters);
    if (format === "json") {
      console.log(JSON.stringify({ ok: true, count: bets.length, bets }, null, 2));
      return;
    }

    const lines = bets.map(formatBetCompact);
    if (format === "telegram") {
      const header = `Bets (${bets.length}):`;
      console.log([header, ...lines].join("\n"));
      return;
    }
    // text
    console.log(lines.join("\n"));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();

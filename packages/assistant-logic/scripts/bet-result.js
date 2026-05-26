#!/usr/bin/env node
/**
 * Update a pending bet's result.
 *
 * Flags:
 *   --id bt_abc123                preferred (exact match)
 *   --match "Pistons vs Magic"    fuzzy match over pending bets (team names / raw_input / notes)
 *   --result win|lose|push|void   required
 *   --notes "TEXT"                optional — appended to existing notes
 *
 * Output: JSON to stdout, errors to stderr.
 * Exit codes:
 *   0 success
 *   1 usage or not-found
 *   2 ambiguous match (>1 candidate)
 */
const { listBets, updateBetResult } = require("./lib/bet-store");
const { fuzzyScore } = require("./lib/fuzzy");

const STRING_FLAGS = new Set(["--id", "--match", "--result", "--notes"]);

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
    i++;
  }
  return args;
}

function fuzzyMatchBets(bets, query) {
  const scored = bets.map((b) => {
    const hay = [
      b.home_team || "",
      b.away_team || "",
      b.raw_input || "",
      b.notes || "",
    ].join(" ");
    return { bet: b, score: fuzzyScore(query, hay) };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best <= 0) return [];
  return scored.filter((s) => s.score === best).map((s) => s.bet);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const result = args["--result"];
  const id = args["--id"];
  const match = args["--match"];
  const notes = args["--notes"];

  if (!result) {
    console.error('Usage: bet-result.js --id bt_... --result win|lose|push|void');
    console.error('       bet-result.js --match "Pistons" --result win');
    process.exit(1);
  }

  if (!id && !match) {
    console.error("Must provide --id or --match");
    process.exit(1);
  }

  let targetId = id;
  if (!targetId && match) {
    const pending = listBets({ result: "pending" });
    const candidates = fuzzyMatchBets(pending, match);
    if (candidates.length === 0) {
      console.error(JSON.stringify({ error: `No pending bet matches "${match}"` }));
      process.exit(1);
    }
    if (candidates.length > 1) {
      console.error(`Ambiguous match — ${candidates.length} pending bets match "${match}":`);
      for (const b of candidates) {
        const teams = b.is_parlay
          ? `parlay(${(b.parlay_legs || []).length})`
          : `${b.home_team} vs ${b.away_team}`;
        console.error(`  ${b.id}  ${b.date}  ${teams}  ${b.odds_american}  ${b.units}u`);
      }
      console.error("\nUse --id to pick one.");
      process.exit(2);
    }
    targetId = candidates[0].id;
  }

  try {
    const res = updateBetResult({ id: targetId, result, notes });
    if (!res.found) {
      console.error(JSON.stringify({ error: `No bet found with id: ${targetId}` }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, bet: res.bet }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();

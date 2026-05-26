#!/usr/bin/env node
/**
 * P&L summary for sports bets in unit terms.
 *
 * Flags:
 *   --since YYYY-MM-DD            default: 30 days ago
 *   --until YYYY-MM-DD            default: today
 *   --month YYYY-MM               shortcut: since = first, until = last of month
 *   --sport nba|nfl|...
 *   --league "Bundesliga"
 *   --platform bet105|dk|...
 *   --group-by sport|league|platform|month|week|day|none   default: none
 *   --include-pending             treat pending bets as open risk
 *   --format json|text|telegram   default: json
 *
 * Output:
 *   json     — full structured summary (or { overall, groups } with --group-by)
 *   telegram — compact Tim-notation multi-line text (units, %, no dollars)
 *   text     — verbose field-per-line breakdown
 */
const { listBets, summarizeBets } = require("./lib/bet-store");

const STRING_FLAGS = new Set([
  "--since",
  "--until",
  "--month",
  "--sport",
  "--league",
  "--platform",
  "--group-by",
  "--format",
]);
const BOOL_FLAGS = new Set(["--include-pending"]);

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

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function monthRange(monthStr) {
  const m = monthStr.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) throw new Error(`Invalid --month: ${monthStr} (use YYYY-MM)`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const first = `${year}-${String(mon).padStart(2, "0")}-01`;
  const lastDay = new Date(year, mon, 0).getDate();
  const last = `${year}-${String(mon).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { since: first, until: last, label: monthLabel(year, mon) };
}

function monthLabel(year, mon) {
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[mon - 1]} ${year}`;
}

function groupKeyFor(bet, groupBy) {
  if (groupBy === "sport") return bet.sport || "unknown";
  if (groupBy === "league") return bet.league || "unknown";
  if (groupBy === "platform") return bet.platform || "unknown";
  if (groupBy === "month") return (bet.date || "").slice(0, 7);
  if (groupBy === "day") return bet.date || "unknown";
  if (groupBy === "week") {
    // ISO-ish week: year-W##
    if (!bet.date) return "unknown";
    const d = new Date(`${bet.date}T12:00:00Z`);
    const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(
      ((d - onejan) / 86400000 + onejan.getUTCDay() + 1) / 7
    );
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return "all";
}

function wlpStr(sum) {
  return `${sum.wins}W-${sum.losses}L-${sum.pushes}P`;
}

function formatNetUnits(n) {
  if (n >= 0) return `+${n.toFixed(2)}u`;
  return `${n.toFixed(2)}u`;
}

function formatTelegram(summary, label) {
  const roiSign = summary.roi_pct >= 0 ? "+" : "";
  const lines = [];
  lines.push(
    `${label}: ${summary.bets} bets (${summary.settled} settled), ${summary.units_risked.toFixed(1)}u risked, net ${formatNetUnits(summary.units_net)}`
  );
  lines.push(
    `  Win rate: ${summary.win_rate_pct.toFixed(1)}% (${wlpStr(summary)})`
  );
  lines.push(`  ROI: ${roiSign}${summary.roi_pct.toFixed(2)}%`);
  if (summary.biggest_win_units > 0 || summary.biggest_loss_units < 0) {
    lines.push(
      `  Biggest win: +${summary.biggest_win_units.toFixed(2)}u`
    );
    lines.push(
      `  Biggest loss: ${summary.biggest_loss_units.toFixed(2)}u`
    );
  }
  return lines.join("\n");
}

function formatTelegramGrouped(overall, groups, label) {
  const lines = [`${label}:`];
  for (const g of groups) {
    const roiSign = g.summary.roi_pct >= 0 ? "+" : "";
    lines.push(
      `  ${g.key}: ${g.summary.bets} bets, ${g.summary.units_risked.toFixed(1)}u risked, net ${formatNetUnits(g.summary.units_net)} (ROI ${roiSign}${g.summary.roi_pct.toFixed(2)}%)`
    );
  }
  lines.push("");
  lines.push(formatTelegram(overall, "Overall"));
  return lines.join("\n");
}

function formatText(summary, label) {
  const lines = [`=== ${label} ===`];
  for (const [k, v] of Object.entries(summary)) {
    lines.push(`${k}: ${v}`);
  }
  return lines.join("\n");
}

function buildLabel(args, explicitLabel) {
  if (explicitLabel) return explicitLabel;
  const parts = [];
  if (args["--sport"]) parts.push(args["--sport"].toUpperCase());
  if (args["--league"]) parts.push(args["--league"]);
  if (args["--platform"]) parts.push(args["--platform"]);
  if (parts.length === 0) parts.push("Bets");
  return parts.join(" ");
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let since = args["--since"];
  let until = args["--until"];
  let rangeLabel = null;

  if (args["--month"]) {
    const r = monthRange(args["--month"]);
    since = since || r.since;
    until = until || r.until;
    rangeLabel = r.label;
  } else {
    if (!since) {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      since = toISODate(d);
    }
    if (!until) {
      until = toISODate(new Date());
    }
  }

  const includePending = args["--include-pending"] === true;
  const groupBy = (args["--group-by"] || "none").toLowerCase();
  const format = (args["--format"] || "json").toLowerCase();

  const filters = {
    since,
    until,
    sport: args["--sport"],
    league: args["--league"],
    platform: args["--platform"],
  };

  try {
    let bets = listBets(filters);
    if (!includePending) {
      bets = bets.filter((b) => b.result && b.result !== "pending");
    }

    const overall = summarizeBets(bets);

    const headerLabel = (() => {
      const filterPart = buildLabel(args);
      if (rangeLabel) return `${filterPart === "Bets" ? "" : filterPart + " "}${rangeLabel}`.trim();
      return `${filterPart} (${since} to ${until})`;
    })();

    if (groupBy === "none") {
      if (format === "json") {
        console.log(JSON.stringify({ range: { since, until }, ...overall }, null, 2));
        return;
      }
      if (format === "telegram") {
        console.log(formatTelegram(overall, headerLabel));
        return;
      }
      console.log(formatText({ range: `${since} to ${until}`, ...overall }, headerLabel));
      return;
    }

    // Grouped
    const groupsMap = new Map();
    for (const b of bets) {
      const key = groupKeyFor(b, groupBy);
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key).push(b);
    }
    const groups = Array.from(groupsMap.entries())
      .map(([key, list]) => ({ key, summary: summarizeBets(list) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    if (format === "json") {
      console.log(
        JSON.stringify(
          {
            range: { since, until },
            overall,
            groups,
          },
          null,
          2
        )
      );
      return;
    }

    if (format === "telegram") {
      console.log(formatTelegramGrouped(overall, groups, headerLabel));
      return;
    }

    // text
    const lines = [`=== ${headerLabel} (grouped by ${groupBy}) ===`];
    for (const g of groups) {
      lines.push(`-- ${g.key} --`);
      for (const [k, v] of Object.entries(g.summary)) {
        lines.push(`  ${k}: ${v}`);
      }
    }
    lines.push("-- OVERALL --");
    for (const [k, v] of Object.entries(overall)) {
      lines.push(`  ${k}: ${v}`);
    }
    console.log(lines.join("\n"));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();

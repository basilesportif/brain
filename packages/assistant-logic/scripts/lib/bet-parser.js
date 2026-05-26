/**
 * Parser for Tim's compact bet notation.
 *
 * Examples it handles:
 *   WIN o2.5 Frankfurt vs RB Leipzig & o2.5 Bayern vs Stuttgart, -141, 3.1u risk
 *   LOSE Pistons (-8.5) vs Magic, -110, 1.5u, Bet105
 *   WIN Thunder (-13) vs Suns, -113, 1.5u
 *   Pistons vs Magic (+9.5), -106, 2.5u, Bet105
 *   o111.5 1st half, Lakers vs Celtics, -115, 1u
 *   Celtics (ML), +150, 2u
 *   WIN +347 ML Lakers vs Celtics, 0.5u
 *
 * Everything is best-effort — unrecognized fields stay null.
 */

const PLATFORM_ALIASES = {
  bet105: "bet105",
  "bet 105": "bet105",
  dk: "dk",
  draftkings: "dk",
  "draft kings": "dk",
  fd: "fanduel",
  fanduel: "fanduel",
  "fan duel": "fanduel",
  mgm: "mgm",
  "bet mgm": "mgm",
  betmgm: "mgm",
  caesars: "caesars",
  caesar: "caesars",
  pinnacle: "pinnacle",
  pinny: "pinnacle",
  fanatics: "fanatics",
};

// Rough team → sport/league dictionaries. Not exhaustive; fallback is null.
const NBA_TEAMS = [
  "lakers", "celtics", "warriors", "nets", "knicks", "76ers", "sixers",
  "bucks", "bulls", "cavaliers", "cavs", "pistons", "pacers", "heat",
  "magic", "hawks", "hornets", "wizards", "raptors", "mavericks", "mavs",
  "nuggets", "rockets", "grizzlies", "timberwolves", "wolves", "thunder",
  "trail blazers", "blazers", "jazz", "suns", "kings", "clippers",
  "pelicans", "spurs",
];

const NFL_TEAMS = [
  "patriots", "bills", "dolphins", "jets", "ravens", "bengals", "browns",
  "steelers", "texans", "colts", "jaguars", "titans", "broncos", "chiefs",
  "raiders", "chargers", "cowboys", "giants", "eagles", "commanders",
  "bears", "lions", "packers", "vikings", "falcons", "panthers", "saints",
  "buccaneers", "bucs", "cardinals", "rams", "49ers", "niners", "seahawks",
];

const MLB_TEAMS = [
  "yankees", "red sox", "blue jays", "orioles", "rays", "white sox",
  "guardians", "tigers", "royals", "twins", "astros", "angels", "athletics",
  "mariners", "rangers", "braves", "marlins", "mets", "phillies", "nationals",
  "cubs", "reds", "brewers", "pirates", "cardinals", "diamondbacks",
  "rockies", "dodgers", "padres", "giants",
];

const NHL_TEAMS = [
  "bruins", "sabres", "red wings", "panthers", "canadiens", "senators",
  "lightning", "maple leafs", "hurricanes", "blue jackets", "devils",
  "islanders", "rangers", "flyers", "penguins", "capitals", "blackhawks",
  "avalanche", "stars", "wild", "predators", "blues", "jets", "coyotes",
  "flames", "oilers", "canucks", "kings", "ducks", "sharks", "kraken",
  "golden knights", "knights",
];

const BUNDESLIGA_TEAMS = [
  "bayern", "dortmund", "rb leipzig", "leipzig", "leverkusen",
  "frankfurt", "stuttgart", "hoffenheim", "wolfsburg", "freiburg",
  "mainz", "union berlin", "gladbach", "borussia", "augsburg", "bochum",
  "heidenheim", "werder bremen", "bremen", "koln", "köln",
];

const EPL_TEAMS = [
  "arsenal", "aston villa", "bournemouth", "brentford", "brighton",
  "burnley", "chelsea", "crystal palace", "everton", "fulham", "liverpool",
  "luton", "manchester city", "man city", "manchester united", "man united",
  "man utd", "newcastle", "nottingham forest", "sheffield united",
  "tottenham", "spurs", "west ham", "wolves", "wolverhampton",
];

function lc(s) {
  return (s || "").toLowerCase();
}

function detectSportAndLeague(homeTeam, awayTeam) {
  const names = `${lc(homeTeam)} ${lc(awayTeam)}`;
  const contains = (list) => list.some((t) => names.includes(t));
  if (contains(NBA_TEAMS)) return { sport: "nba", league: "NBA" };
  if (contains(NFL_TEAMS)) return { sport: "nfl", league: "NFL" };
  if (contains(MLB_TEAMS)) return { sport: "mlb", league: "MLB" };
  if (contains(NHL_TEAMS)) return { sport: "nhl", league: "NHL" };
  if (contains(BUNDESLIGA_TEAMS))
    return { sport: "soccer", league: "Bundesliga" };
  if (contains(EPL_TEAMS)) return { sport: "soccer", league: "EPL" };
  return { sport: null, league: null };
}

function detectPlatform(text) {
  const t = lc(text);
  // Order longer keys first so "bet 105" wins over "bet".
  const keys = Object.keys(PLATFORM_ALIASES).sort(
    (a, b) => b.length - a.length
  );
  for (const key of keys) {
    // use word boundary-ish check
    const re = new RegExp(`(^|[^a-z0-9])${key.replace(/ /g, "\\s*")}(?![a-z0-9])`, "i");
    if (re.test(t)) return PLATFORM_ALIASES[key];
  }
  return null;
}

function detectHalf(text) {
  const t = lc(text);
  if (/\b(1st half|1h|first half)\b/.test(t)) return "1h";
  if (/\b(2nd half|2h|second half)\b/.test(t)) return "2h";
  if (/\b(halftime|ht)\b/.test(t)) return "ht";
  if (/\b1q\b/.test(t)) return "1q";
  if (/\b2q\b/.test(t)) return "2q";
  if (/\b3q\b/.test(t)) return "3q";
  if (/\b4q\b/.test(t)) return "4q";
  return "full";
}

function detectResult(text) {
  const m = text.match(/^\s*(WIN|LOSE|LOSS|PUSH|VOID|PENDING)\b/i);
  if (!m) return null;
  const r = m[1].toUpperCase();
  if (r === "WIN") return "win";
  if (r === "LOSE" || r === "LOSS") return "lose";
  if (r === "PUSH") return "push";
  if (r === "VOID") return "void";
  if (r === "PENDING") return "pending";
  return null;
}

function stripResultPrefix(text) {
  return text.replace(/^\s*(WIN|LOSE|LOSS|PUSH|VOID|PENDING)\b\s*/i, "");
}

function detectUnitsAndRiskType(text) {
  // Matches "3.1u risk", "1.5u to win", "0.75u"
  const m = text.match(/(\d+(?:\.\d+)?)\s*u(?:\s*(risk|to\s*win))?/i);
  if (!m) return { units: null, risk_or_to_win: "risk" };
  const units = Number(m[1]);
  let rtw = "risk";
  if (m[2]) {
    rtw = /to\s*win/i.test(m[2]) ? "to_win" : "risk";
  }
  return { units, risk_or_to_win: rtw };
}

function detectOdds(text) {
  // Find a signed integer in the 3-4 digit odds range that is NOT attached
  // to a spread parenthetical and NOT followed by "u" (units).
  // We scan all candidates and prefer those appearing after a comma.
  const candidates = [];
  const re = /([+-])\s*(\d{3,4})(?!\.?\d*\s*u)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const sign = m[1];
    const num = m[2];
    const idx = m.index;
    // Skip if this is inside a parentheses (likely a spread line)
    const before = text.slice(Math.max(0, idx - 10), idx);
    const after = text.slice(idx, idx + 10);
    if (/\([^)]*$/.test(before) && /^[^(]*\)/.test(after)) continue;
    candidates.push({
      value: Number(`${sign}${num}`),
      idx,
      afterComma: /,\s*$/.test(text.slice(0, idx)) || /,\s*[+-]?$/.test(text.slice(0, idx)),
    });
  }
  if (!candidates.length) return null;
  // Prefer candidate after a comma, else last one.
  const afterComma = candidates.filter((c) => c.afterComma);
  if (afterComma.length) return afterComma[afterComma.length - 1].value;
  return candidates[candidates.length - 1].value;
}

/**
 * Extract teams + spread market from a segment like:
 *   "Pistons (-8.5) vs Magic"
 *   "Thunder vs Suns (+9.5)"
 *   "Frankfurt vs RB Leipzig"
 *   "Celtics (ML)"
 */
function detectTeamsAndSpread(segment) {
  // Strip half qualifier phrases for cleaner matching
  const cleaned = segment
    .replace(/\b(1st half|first half|1h|2nd half|second half|2h|halftime|ht|1q|2q|3q|4q)\b/gi, "")
    .trim();

  // Match "X vs Y" pattern
  const vsMatch = cleaned.match(/^(.*?)\s+vs\.?\s+(.+?)$/i);
  if (!vsMatch) return null;

  let left = vsMatch[1].trim();
  let right = vsMatch[2].trim();

  let line = null;
  let side = null;
  let market = null;

  // Check for ML in either side
  const mlRe = /\(\s*ML\s*\)/i;
  if (mlRe.test(left)) {
    left = left.replace(mlRe, "").trim();
    market = "moneyline";
    side = "home";
  } else if (mlRe.test(right)) {
    right = right.replace(mlRe, "").trim();
    market = "moneyline";
    side = "away";
  }

  // Check for spread in parens
  const spreadRe = /\(\s*([+-]?\d+(?:\.\d+)?)\s*\)/;
  if (!market) {
    const leftSpread = left.match(spreadRe);
    const rightSpread = right.match(spreadRe);
    if (leftSpread) {
      line = Number(leftSpread[1]);
      left = left.replace(spreadRe, "").trim();
      market = "spread";
      side = "home";
    } else if (rightSpread) {
      line = Number(rightSpread[1]);
      right = right.replace(spreadRe, "").trim();
      market = "spread";
      side = "away";
    }
  }

  // Clean trailing/leading punctuation from team names
  const cleanName = (s) => {
    if (!s) return null;
    return s.replace(/^[\s,.\-]+|[\s,.\-]+$/g, "").replace(/\s{2,}/g, " ").trim() || null;
  };

  return {
    home_team: cleanName(left),
    away_team: cleanName(right),
    line,
    side,
    market,
  };
}

/**
 * Detect total market: "o2.5", "o217.5", "u111.5", etc.
 * Returns {market, side, line} or null if no total match.
 */
function detectTotal(segment) {
  const m = segment.match(/\b([ou])(\d+(?:\.\d+)?)\b/i);
  if (!m) return null;
  return {
    market: "total",
    side: m[1].toLowerCase() === "o" ? "over" : "under",
    line: Number(m[2]),
  };
}

/** Strip total notation, odds, units, platform, half qualifier from a segment to leave the team/market core. */
function stripExtrasForTeamMatch(segment) {
  let s = segment;
  // Strip odds like -110, +347 (signed 3-4 digit)
  s = s.replace(/([,\s])[+-]\d{3,4}(?!\.?\d*u)/g, "$1");
  // Strip units
  s = s.replace(/\d+(?:\.\d+)?\s*u(?:\s*(?:risk|to\s*win))?/gi, "");
  // Strip platform aliases (use same detection)
  for (const key of Object.keys(PLATFORM_ALIASES).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^a-z0-9])${key.replace(/ /g, "\\s*")}(?![a-z0-9])`, "ig");
    s = s.replace(re, "$1");
  }
  // Strip total notation
  s = s.replace(/\b[ou]\d+(?:\.\d+)?\b/gi, "");
  // Strip half qualifier phrases
  s = s.replace(/\b(1st half|first half|1h|2nd half|second half|2h|halftime|ht|1q|2q|3q|4q)\b/gi, "");
  // Strip leading result
  s = s.replace(/^\s*(WIN|LOSE|LOSS|PUSH|VOID|PENDING)\b/i, "");
  // Collapse commas and whitespace
  s = s.replace(/,+/g, ",").replace(/,\s*$/g, "").replace(/^\s*,/g, "").trim();
  s = s.replace(/\s{2,}/g, " ");
  return s;
}

/**
 * Parse a single (non-parlay) bet line into a draft bet object.
 * Returns whatever fields could be extracted; unknowns are null.
 */
function parseBetLine(text) {
  const raw_input = (text || "").trim();
  if (!raw_input) return null;

  const result = detectResult(raw_input) || "pending";
  const half_qualifier = detectHalf(raw_input);
  const platform = detectPlatform(raw_input) || "unknown";
  const odds_american = detectOdds(raw_input);
  const { units, risk_or_to_win } = detectUnitsAndRiskType(raw_input);

  // Work on a cleaned segment for market/team detection
  const afterResult = stripResultPrefix(raw_input);

  // Detect total first (cheap regex)
  const total = detectTotal(afterResult);

  // Detect teams
  const teamCore = stripExtrasForTeamMatch(afterResult);
  const teams = detectTeamsAndSpread(teamCore);

  let market = null;
  let side = null;
  let line = null;
  let home_team = null;
  let away_team = null;

  if (total) {
    market = "total";
    side = total.side;
    line = total.line;
    if (teams) {
      home_team = teams.home_team;
      away_team = teams.away_team;
    }
  } else if (teams) {
    market = teams.market;
    side = teams.side;
    line = teams.line;
    home_team = teams.home_team;
    away_team = teams.away_team;
  }

  const { sport, league } = detectSportAndLeague(home_team, away_team);

  return {
    date: null,
    result,
    sport,
    league,
    market,
    side,
    home_team,
    away_team,
    line,
    half_qualifier,
    odds_american,
    units,
    risk_or_to_win,
    platform,
    is_parlay: false,
    parlay_legs: null,
    raw_input,
    notes: "",
  };
}

/**
 * Parse a parlay line (contains "&") — split on &, parse each leg, strip
 * odds/units from legs. Returns a parlay draft:
 *   { is_parlay, parlay_legs, odds_american, units, risk_or_to_win, result, raw_input }
 */
function parseParlay(text) {
  const raw_input = (text || "").trim();
  if (!raw_input) return null;

  const result = detectResult(raw_input) || "pending";
  const platform = detectPlatform(raw_input) || "unknown";
  const odds_american = detectOdds(raw_input);
  const { units, risk_or_to_win } = detectUnitsAndRiskType(raw_input);

  // Strip trailing odds/units/platform group — usually after the last comma.
  // For each leg, parse as a non-parlay draft, then keep leg-relevant fields.
  const afterResult = stripResultPrefix(raw_input);

  // Split at top-level & (assume no parens contain &; splitting is fine).
  const legsRaw = afterResult
    .split("&")
    .map((s) => s.trim())
    .filter(Boolean);

  const parlay_legs = legsRaw.map((legText) => {
    // Strip odds/units/platform so parsed leg fields are market-only.
    const legDraft = parseBetLine(legText);
    if (!legDraft) return null;
    return {
      sport: legDraft.sport,
      league: legDraft.league,
      home_team: legDraft.home_team,
      away_team: legDraft.away_team,
      market: legDraft.market,
      side: legDraft.side,
      line: legDraft.line,
      half_qualifier: legDraft.half_qualifier || "full",
    };
  }).filter(Boolean);

  return {
    date: null,
    is_parlay: true,
    parlay_legs,
    odds_american,
    units,
    risk_or_to_win,
    result,
    platform,
    raw_input,
    notes: "",
  };
}

/**
 * Parse a multi-line block like:
 *
 *   ### 2026 04 19
 *   * WIN o2.5 Frankfurt vs RB Leipzig & o2.5 Bayern vs Stuttgart, -141, 3.1u risk
 *   * LOSE Pistons (-8.5) vs Magic, -110, 1.5u, Bet105
 *
 * Returns { date: "YYYY-MM-DD" | null, bets: [...drafts] }.
 */
function parseMultiBetBlock(text) {
  const lines = (text || "").split(/\r?\n/);
  let date = null;
  const bets = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Date header: "### 2026 04 19" or "### 2026-04-19" or bare "2026-04-19"
    const dateMatch = trimmed.match(/^#{0,4}\s*(\d{4})[\s\-_/.](\d{1,2})[\s\-_/.](\d{1,2})\b/);
    if (dateMatch) {
      const y = dateMatch[1];
      const m = String(dateMatch[2]).padStart(2, "0");
      const d = String(dateMatch[3]).padStart(2, "0");
      date = `${y}-${m}-${d}`;
      continue;
    }

    // Bet bullet: "* ..." or "- ..." or plain text
    let body = trimmed.replace(/^[\*\-]\s*/, "");
    if (!body) continue;
    // Skip if it's just a heading
    if (body.startsWith("#")) continue;

    const draft = body.includes("&") ? parseParlay(body) : parseBetLine(body);
    if (draft) {
      if (date && !draft.date) draft.date = date;
      bets.push(draft);
    }
  }

  return { date, bets };
}

module.exports = {
  parseBetLine,
  parseParlay,
  parseMultiBetBlock,
  detectSportAndLeague,
  detectPlatform,
  detectHalf,
  detectResult,
  detectOdds,
  detectUnitsAndRiskType,
};

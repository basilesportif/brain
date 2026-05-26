const crypto = require("crypto");
const { createStateStore } = require("./state-stores");

const SCHEMA_VERSION = 1;

const VALID_RESULTS = ["pending", "win", "lose", "push", "void"];
const VALID_MARKETS = ["spread", "moneyline", "total", "prop", "parlay"];
const VALID_SIDES = ["home", "away", "over", "under"];
const VALID_HALVES = ["full", "1h", "2h", "1q", "2q", "3q", "4q", "ht"];
const VALID_RISK_TYPES = ["risk", "to_win"];

function generateBetId() {
  return `bt_${crypto.randomBytes(8).toString("hex")}`;
}

function createEmptyStore() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    bets: [],
  };
}

function getBetStore(options = {}) {
  return createStateStore("bets", {
    ...options,
    defaultValue: createEmptyStore,
    onLoad(store) {
      const next =
        store && typeof store === "object" ? store : createEmptyStore();
      if (!Array.isArray(next.bets)) next.bets = [];
      return next;
    },
  });
}

function loadStore(options = {}) {
  return getBetStore(options).load();
}

function saveStore(store, options = {}) {
  store.updatedAt = new Date().toISOString();
  return getBetStore(options).save(store);
}

/** American odds → unit payout ratio on a WIN (for 1u risked). */
function payoutRatio(oddsAmerican) {
  const o = Number(oddsAmerican);
  if (!Number.isFinite(o) || o === 0) return 0;
  if (o < 0) return 100 / Math.abs(o);
  return o / 100;
}

/** Compute unit delta for a single settled bet (NOT parlay-aware differently — top-level odds applies). */
function unitDelta(bet) {
  const result = bet.result;
  const units = Number(bet.units) || 0;
  const ratio = payoutRatio(bet.odds_american);
  const riskMode = bet.risk_or_to_win || "risk";

  if (result === "push" || result === "void") return 0;
  if (result === "pending") return 0;

  if (riskMode === "to_win") {
    // units = target win; risk = units / ratio
    if (result === "win") return units;
    if (result === "lose") return ratio > 0 ? -(units / ratio) : 0;
    return 0;
  }

  // default: risk
  if (result === "win") return units * ratio;
  if (result === "lose") return -units;
  return 0;
}

/** Effective units risked for a bet (used in ROI denominator). */
function unitsRisked(bet) {
  const units = Number(bet.units) || 0;
  const ratio = payoutRatio(bet.odds_american);
  const riskMode = bet.risk_or_to_win || "risk";
  if (riskMode === "to_win") {
    return ratio > 0 ? units / ratio : 0;
  }
  return units;
}

function assertEnum(name, value, allowed) {
  if (value === undefined || value === null) return;
  if (!allowed.includes(value)) {
    throw new Error(
      `Invalid ${name}: "${value}". Must be one of: ${allowed.join(", ")}`
    );
  }
}

function validateDate(value) {
  if (!value || typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date (need YYYY-MM-DD): ${value}`);
  }
}

function addBet(fields, options = {}) {
  const {
    date,
    result = "pending",
    sport = null,
    league = null,
    market,
    side = null,
    home_team = null,
    away_team = null,
    line = null,
    half_qualifier = "full",
    odds_american,
    units,
    risk_or_to_win = "risk",
    platform = "unknown",
    is_parlay = false,
    parlay_legs = null,
    raw_input = "",
    notes = "",
    source = "manual",
  } = fields || {};

  validateDate(date);
  assertEnum("result", result, VALID_RESULTS);
  assertEnum("market", market, VALID_MARKETS);
  assertEnum("side", side, VALID_SIDES);
  assertEnum("half_qualifier", half_qualifier, VALID_HALVES);
  assertEnum("risk_or_to_win", risk_or_to_win, VALID_RISK_TYPES);

  if (!market) throw new Error("market is required");
  if (odds_american === undefined || odds_american === null || !Number.isFinite(Number(odds_american))) {
    throw new Error("odds_american is required (signed integer)");
  }
  if (units === undefined || units === null || !Number.isFinite(Number(units)) || Number(units) <= 0) {
    throw new Error("units is required (positive decimal)");
  }

  const parlayMode =
    is_parlay === true ||
    market === "parlay" ||
    (Array.isArray(parlay_legs) && parlay_legs.length > 0);

  if (!parlayMode) {
    if (!home_team) throw new Error("home_team is required for non-parlay bets");
    if (!away_team) throw new Error("away_team is required for non-parlay bets");
    if ((market === "spread" || market === "total") && (line === null || line === undefined || !Number.isFinite(Number(line)))) {
      throw new Error(`line is required for ${market} bets`);
    }
    if (market !== "prop" && !side) {
      throw new Error(`side is required for ${market} bets`);
    }
  } else {
    if (!Array.isArray(parlay_legs) || parlay_legs.length < 2) {
      throw new Error("parlay requires parlay_legs array with at least 2 legs");
    }
  }

  const store = loadStore(options);
  const now = new Date().toISOString();

  const bet = {
    id: generateBetId(),
    date,
    result,
    sport: sport || null,
    league: league || null,
    market: parlayMode ? "parlay" : market,
    side: parlayMode ? null : side,
    home_team: parlayMode ? null : home_team,
    away_team: parlayMode ? null : away_team,
    line: parlayMode ? null : (line === null || line === undefined ? null : Number(line)),
    half_qualifier: parlayMode ? "full" : (half_qualifier || "full"),
    odds_american: Math.trunc(Number(odds_american)),
    units: Number(units),
    risk_or_to_win,
    platform: platform || "unknown",
    is_parlay: parlayMode,
    parlay_legs: parlayMode ? parlay_legs : null,
    raw_input: raw_input || "",
    notes: notes || "",
    created_at: now,
    updated_at: now,
    settled_at: result === "pending" ? null : now,
    source: source || "manual",
  };

  store.bets.push(bet);
  saveStore(store, options);
  return bet;
}

function dateInRange(dateStr, since, until) {
  if (since && dateStr < since) return false;
  if (until && dateStr > until) return false;
  return true;
}

function listBets(filters = {}, options = {}) {
  const store = loadStore(options);
  const {
    date,
    since,
    until,
    sport,
    league,
    platform,
    result,
    parlaysOnly,
    noParlays,
    id,
    query,
    limit,
  } = filters;

  let bets = store.bets.slice();

  if (id) bets = bets.filter((b) => b.id === id);
  if (date) bets = bets.filter((b) => b.date === date);
  if (since || until) bets = bets.filter((b) => dateInRange(b.date, since, until));
  if (sport) {
    const s = sport.toLowerCase();
    bets = bets.filter((b) => (b.sport || "").toLowerCase() === s);
  }
  if (league) {
    const l = league.toLowerCase();
    bets = bets.filter((b) => (b.league || "").toLowerCase().includes(l));
  }
  if (platform) {
    const p = platform.toLowerCase();
    bets = bets.filter((b) => (b.platform || "").toLowerCase() === p);
  }
  if (result) bets = bets.filter((b) => b.result === result);
  if (parlaysOnly) bets = bets.filter((b) => b.is_parlay === true);
  if (noParlays) bets = bets.filter((b) => b.is_parlay !== true);

  if (query) {
    const q = query.toLowerCase();
    bets = bets.filter((b) => {
      const fields = [
        b.home_team,
        b.away_team,
        b.raw_input,
        b.notes,
        b.league,
        b.sport,
      ];
      if (Array.isArray(b.parlay_legs)) {
        for (const leg of b.parlay_legs) {
          fields.push(leg.home_team, leg.away_team, leg.league);
        }
      }
      return fields.some((f) => f && String(f).toLowerCase().includes(q));
    });
  }

  // Sort by date ascending, then created_at ascending.
  bets.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ac = a.created_at || "";
    const bc = b.created_at || "";
    return ac < bc ? -1 : ac > bc ? 1 : 0;
  });

  if (limit && Number.isFinite(Number(limit))) {
    const n = Math.max(0, Math.trunc(Number(limit)));
    if (bets.length > n) bets = bets.slice(bets.length - n);
  }

  return bets;
}

function updateBetResult({ id, result, notes }, options = {}) {
  assertEnum("result", result, ["win", "lose", "push", "void"]);
  if (!id) throw new Error("id is required");
  const store = loadStore(options);
  const bet = store.bets.find((b) => b.id === id);
  if (!bet) return { found: false };
  bet.result = result;
  bet.settled_at = new Date().toISOString();
  bet.updated_at = bet.settled_at;
  if (notes) {
    const appended = bet.notes ? `${bet.notes}\n${notes}` : notes;
    bet.notes = appended;
  }
  saveStore(store, options);
  return { found: true, bet };
}

function deleteBetById(id, options = {}) {
  const store = loadStore(options);
  const index = store.bets.findIndex((b) => b.id === id);
  if (index === -1) return { found: false };
  const [removed] = store.bets.splice(index, 1);
  saveStore(store, options);
  return { found: true, deleted: removed };
}

function round(n, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function summarizeBets(bets) {
  const settled = bets.filter((b) => b.result && b.result !== "pending");
  const pending = bets.filter((b) => b.result === "pending");
  const wins = settled.filter((b) => b.result === "win");
  const losses = settled.filter((b) => b.result === "lose");
  const pushes = settled.filter((b) => b.result === "push");
  const voids = settled.filter((b) => b.result === "void");

  let unitsRiskedTotal = 0;
  let unitsNet = 0;
  let biggestWin = 0;
  let biggestLoss = 0;
  let oddsSum = 0;
  let oddsCount = 0;

  for (const b of settled) {
    // Include pushes/voids in denominator (capital was deployed)
    unitsRiskedTotal += unitsRisked(b);
    const d = unitDelta(b);
    unitsNet += d;
    if (d > biggestWin) biggestWin = d;
    if (d < biggestLoss) biggestLoss = d;
    if (Number.isFinite(Number(b.odds_american))) {
      oddsSum += Number(b.odds_american);
      oddsCount += 1;
    }
  }

  const winsLossesPushes = wins.length + losses.length + pushes.length;
  const winRate =
    winsLossesPushes > 0 ? (wins.length / winsLossesPushes) * 100 : 0;
  const roi = unitsRiskedTotal > 0 ? (unitsNet / unitsRiskedTotal) * 100 : 0;
  const avgOdds = oddsCount > 0 ? Math.round(oddsSum / oddsCount) : 0;

  return {
    bets: bets.length,
    settled: settled.length,
    pending: pending.length,
    wins: wins.length,
    losses: losses.length,
    pushes: pushes.length,
    voids: voids.length,
    units_risked: round(unitsRiskedTotal, 2),
    units_net: round(unitsNet, 2),
    roi_pct: round(roi, 2),
    win_rate_pct: round(winRate, 2),
    avg_odds_american: avgOdds,
    biggest_win_units: round(biggestWin, 2),
    biggest_loss_units: round(biggestLoss, 2),
  };
}

module.exports = {
  SCHEMA_VERSION,
  generateBetId,
  createEmptyStore,
  getBetStore,
  loadStore,
  saveStore,
  addBet,
  listBets,
  updateBetResult,
  deleteBetById,
  summarizeBets,
  payoutRatio,
  unitDelta,
  unitsRisked,
  VALID_RESULTS,
  VALID_MARKETS,
  VALID_SIDES,
  VALID_HALVES,
  VALID_RISK_TYPES,
};

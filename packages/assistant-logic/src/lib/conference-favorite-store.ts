// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock, writeJsonAtomic } from "./json-store.js";

const DEFAULT_WORKSPACE_PATH = "/home/tim/.assistant-claude/workspace";
const CONFERENCE_LISTS_RELATIVE = path.join("data", "conference-lists");

function normalizeSelector(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeJsonAtomic(filePath, value);
}

function getConferenceListsRoot(options = {}) {
  return path.join(options.workspacePath || process.env.ASSISTANT_WORKSPACE || DEFAULT_WORKSPACE_PATH, CONFERENCE_LISTS_RELATIVE);
}

function listConferenceLists(options = {}) {
  const root = getConferenceListsRoot(options);
  if (!fs.existsSync(root)) return [];
  const requested = options.listIds ? new Set(options.listIds) : null;
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => !requested || requested.has(id))
    .map((id) => {
      const listPath = path.join(root, id);
      return {
        id,
        listPath,
        dataPath: path.join(listPath, "conferences.json"),
        manifestPath: path.join(listPath, "manifest.json"),
      };
    })
    .filter((list) => fs.existsSync(list.dataPath));
}

function findMatches(rows, selector) {
  const needle = normalizeSelector(selector);
  if (!needle) throw new Error("Conference id or name is required");

  const exactId = rows.filter((row) => normalizeSelector(row.id) === needle);
  if (exactId.length) return exactId;

  const exactName = rows.filter((row) => normalizeSelector(row.name) === needle);
  if (exactName.length) return exactName;

  return rows.filter((row) => {
    const haystack = normalizeSelector([row.id, row.name].filter(Boolean).join(" "));
    return haystack.includes(needle);
  });
}

function applyFavoriteUpdate(row, options = {}) {
  const favorite = options.favorite !== false;
  const next = { ...row };
  if (favorite) {
    next.favorite = true;
    next.favoritedAt = options.at || new Date().toISOString();
    if (options.note !== undefined) {
      const note = String(options.note || "").trim();
      if (note) next.favoriteNote = note;
      else delete next.favoriteNote;
    }
  } else {
    next.favorite = false;
    delete next.favoritedAt;
    if (!options.keepNote) delete next.favoriteNote;
  }
  return next;
}

function updateRowsForSelector(rows, selector, options = {}) {
  const matches = findMatches(rows, selector);
  if (matches.length > 1) {
    const labels = matches.map((row) => `${row.id} (${row.name})`).join(", ");
    throw new Error(`Selector matched multiple conferences in one list: ${labels}`);
  }
  if (matches.length === 0) {
    return { rows, updated: [] };
  }

  const matchId = matches[0].id;
  const updatedRows = rows.map((row) => (row.id === matchId ? applyFavoriteUpdate(row, options) : row));
  return { rows: updatedRows, updated: [updatedRows.find((row) => row.id === matchId)] };
}

function updateListManifest(manifestPath, rows, now) {
  let manifest = {};
  if (fs.existsSync(manifestPath)) manifest = readJson(manifestPath);
  manifest.updatedAt = now;
  manifest.recordCount = rows.length;
  manifest.favoriteCount = rows.filter((row) => row.favorite === true).length;
  manifest.favoriteUpdatedAt = now;
  writeJson(manifestPath, manifest);
}

function getSingleListForWrite(args = {}, options = {}) {
  const listId = args.listId || (Array.isArray(args.listIds) && args.listIds.length === 1 ? args.listIds[0] : null);
  if (!listId) throw new Error("A single --list <list-id> is required");
  const root = getConferenceListsRoot({ workspacePath: options.workspacePath || args.workspacePath });
  const listPath = path.join(root, listId);
  fs.mkdirSync(listPath, { recursive: true });
  return {
    id: listId,
    listPath,
    dataPath: path.join(listPath, "conferences.json"),
    manifestPath: path.join(listPath, "manifest.json"),
  };
}

function updateConferenceFavorites(args = {}, options = {}) {
  const selector = args.selector;
  const at = args.at || new Date().toISOString();
  const lists = listConferenceLists({ workspacePath: options.workspacePath || args.workspacePath, listIds: args.listIds });
  if (args.listIds?.length) {
    const found = new Set(lists.map((list) => list.id));
    const missing = args.listIds.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`Unknown conference list(s): ${missing.join(", ")}`);
  }

  const changes = [];
  for (const list of lists) {
    const listChanges = withFileLock(list.dataPath, () => {
      const rows = readJson(list.dataPath);
      const result = updateRowsForSelector(rows, selector, {
        favorite: args.favorite,
        note: args.note,
        keepNote: args.keepNote,
        at,
      });
      if (result.updated.length === 0) return [];
      writeJson(list.dataPath, result.rows);
      updateListManifest(list.manifestPath, result.rows, at);
      return result.updated.map((row) => ({
        listId: list.id,
        dataPath: list.dataPath,
        id: row.id,
        name: row.name,
        favorite: row.favorite === true,
        favoritedAt: row.favoritedAt || null,
        favoriteNote: row.favoriteNote || null,
      }));
    }, options.lock);
    changes.push(...listChanges);
  }

  if (changes.length === 0) {
    throw new Error(`No conference matched "${selector}" in ${lists.length} conference list(s)`);
  }
  return { ok: true, changes };
}

function listFavoriteConferences(options = {}) {
  return listConferences({ ...options, favoritesOnly: true });
}

function listConferences(options = {}) {
  const query = options.query ? normalizeSelector(options.query) : "";
  return listConferenceLists(options).flatMap((list) => {
    const rows = withFileLock(list.dataPath, () => readJson(list.dataPath), options.lock);
    return rows
      .filter((row) => !options.favoritesOnly || row.favorite === true)
      .filter((row) => {
        if (!query) return true;
        const haystack = normalizeSelector([row.id, row.name, row.city, row.region, row.dates].filter(Boolean).join(" "));
        return haystack.includes(query);
      })
      .map((row) => ({
        listId: list.id,
        id: row.id,
        name: row.name,
        dates: row.dates,
        city: row.city,
        region: row.region,
        favorite: row.favorite === true,
        favoritedAt: row.favoritedAt || null,
        favoriteNote: row.favoriteNote || null,
      }));
  });
}

function addConferenceRecord(args = {}, options = {}) {
  const list = getSingleListForWrite(args, options);
  const at = args.at || new Date().toISOString();
  const record = { ...(args.record || {}) };
  record.id = String(record.id || args.id || "").trim();
  record.name = String(record.name || args.name || "").trim();
  if (!record.id) throw new Error("Conference id is required");
  if (!record.name) throw new Error("Conference name is required");

  return withFileLock(list.dataPath, () => {
    const rows = fs.existsSync(list.dataPath) ? readJson(list.dataPath) : [];
    if (!Array.isArray(rows)) throw new Error(`${list.dataPath} must contain a JSON array`);
    const duplicate = rows.find((row) => normalizeSelector(row.id) === normalizeSelector(record.id));
    if (duplicate) throw new Error(`Conference id already exists in ${list.id}: ${record.id}`);
    if (!record.createdAt) record.createdAt = at;
    record.updatedAt = at;
    const nextRows = [...rows, record];
    writeJson(list.dataPath, nextRows);
    updateListManifest(list.manifestPath, nextRows, at);
    return { ok: true, listId: list.id, dataPath: list.dataPath, conference: record };
  }, options.lock);
}

export {
  DEFAULT_WORKSPACE_PATH,
  CONFERENCE_LISTS_RELATIVE,
  applyFavoriteUpdate,
  findMatches,
  getConferenceListsRoot,
  addConferenceRecord,
  listConferences,
  listConferenceLists,
  listFavoriteConferences,
  normalizeSelector,
  updateConferenceFavorites,
  updateRowsForSelector,
};
